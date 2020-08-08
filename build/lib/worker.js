"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
const logger_1 = require("./services/logger");
const pods_1 = require("./helpers/pods");
const worker_status_1 = require("./worker-status");
const dns_1 = require("dns");
const os_1 = require("os");
const util_1 = require("util");
const mongo_1 = require("./mongo");
const colors_1 = __importDefault(require("colors"));
// import { getClient, replSetGetStatus, initReplSet, addNewReplSetMembers, isInReplSet, MongoManager } from './mongo';
// import { init as _init, getMongoPods } from './k8s_old';
const config_1 = require("./config");
// import { loopSleepSeconds } from './config_old';
const k8s_1 = require("./k8s");
const common_1 = require("./common");
const replica_changes_1 = require("./replica-changes");
class Worker {
    constructor() {
        this.config = new config_1.Config();
        this.loopSleepSeconds = this.config.loopSleepSeconds;
        this.unhealthySeconds = this.config.unhealthySeconds;
        this.k8sClient = new k8s_1.K8sClient(this.config);
        this.mongoManager = new mongo_1.MongoManager(this.config);
        this.workerStatus = new worker_status_1.WorkerStatus();
        this.podHelper = new pods_1.PodHelper(this.config);
        this.connected = false;
    }
    async init() {
        // Borrowed from here: http://stackoverflow.com/questions/3653065/get-local-ip-address-in-node-js
        const hostName = os_1.hostname();
        const lookup = util_1.promisify(dns_1.lookup);
        try {
            const hostLookupIp = await lookup(hostName);
            this.hostIp = hostLookupIp.address;
            this.hostIpAndPort = this.hostIp + ':' + this.config.mongoPort;
        }
        catch (err) {
            return Promise.reject(err);
        }
        try {
            await this.k8sClient.init();
            await this.mongoClientInit();
        }
        catch (err) {
            return Promise.reject(err);
        }
        return;
    }
    async doWork() {
        var _a, _b, _c, _d;
        if (!this.connected) {
            logger_1.Logger.blue(colors_1.default.green('No connection to mongodb, connecting to '));
            this.mongoClientInit();
        }
        const now = new Date();
        if (!this.hostIp || !this.hostIpAndPort) {
            throw new Error("Must initialize with the host machine's addr");
        }
        if (!this.config.k8sMongoServiceName) {
            throw new Error('You need to have a Headless Service to connect the replication service');
        }
        try {
            this.pods = await this.k8sClient.getMongoServicePods();
        }
        catch (err) {
            return this.finishWork(err);
        }
        if (!((_a = this.pods) === null || _a === void 0 ? void 0 : _a.items)) {
            this.workerStatus.members = [];
            return this.finishWork('There was an error collecting the pods');
        }
        // Getting an up to date list of available pods in the namespace
        try {
            this.workerStatus.availablePods = [];
            this.workerStatus.pods = [];
            // Lets remove any pods that aren't running or haven't been assigned an IP address yet
            for (let i = this.pods.items.length - 1; i >= 0; i--) {
                const pod = this.pods.items[i];
                if (((_b = pod.status) === null || _b === void 0 ? void 0 : _b.phase) !== 'Running' || !((_c = pod.status) === null || _c === void 0 ? void 0 : _c.podIP)) {
                    this.pods.items.splice(i, 1);
                }
            }
            // Pushing changes to the workerStatus Pods
            this.pods.items.forEach((pod) => {
                this.workerStatus.availablePods.push(this.podHelper.toPodMember(pod));
                this.workerStatus.pods.push(this.podHelper.toPodMember(pod));
            });
            logger_1.Logger.information('Available Pods:');
            this.workerStatus.pods.forEach((pod) => {
                logger_1.Logger.information(`  - Pod: ${pod.host} -> ${pod.ip}`);
            });
            if (!this.workerStatus.availablePods.length) {
                return this.finishWork('No pods are currently running, probably just give them some time.', true);
            }
        }
        catch (error) {
            logger_1.Logger.error(`There was an error processing live pods, we will try again in ${this.loopSleepSeconds}s`, error);
            this.finishWork(error);
        }
        // We have the pods, lets query mongo to get the replica set status
        try {
            const lastUpdate = new Date(this.workerStatus.replicaSetStatusLastUpdate).addHours(1);
            if (this.workerStatus.replicaSetStatusLastUpdate < 0 || lastUpdate.getTime() < now.getTime()) {
                logger_1.Logger.information(`ReplicaSet Status is too old, we will update it`);
                let replicaSetStatus;
                try {
                    replicaSetStatus = await this.mongoManager.getReplicaSetStatus();
                }
                catch (error) {
                    replicaSetStatus = {
                        ok: 0,
                        code: -1,
                    };
                    this.finishWork(error, true);
                }
                if (replicaSetStatus) {
                    logger_1.Logger.debug('replicasetStatus', replicaSetStatus);
                    this.workerStatus.replicaSetStatus = replicaSetStatus;
                    this.workerStatus.replicaSetStatusLastUpdate = now.getTime();
                    this.workerStatus.set = replicaSetStatus.set;
                    this.workerStatus.lastStatusCode = replicaSetStatus.code;
                }
                else {
                    this.finishWork('Could not find a valid ReplicaSetStatus', true);
                }
            }
            if (this.workerStatus.replicaSetStatus) {
                switch (this.workerStatus.replicaSetStatus.code) {
                    case 94:
                        await this.initiateReplicaSet();
                        if (this.workerStatus.pods.length > 1) {
                            this.workerStatus.replicaSetStatusLastUpdate = -1;
                        }
                        break;
                    case 0:
                        // TODO: Force connection to primary;
                        logger_1.Logger.success(`ReplicaSet is initiated and healthy, found ${(_d = this.workerStatus.replicaSetStatus.members) === null || _d === void 0 ? void 0 : _d.length} node in replica members`);
                        // TODO: Remove this old array
                        this.workerStatus.members = [];
                        logger_1.Logger.info(`Mapping MongoDB ReplicaSet Members to Worker Pods:`);
                        this.matchReplicaSetStateMembersToPodMembers();
                        this.generateReplicaSetInstructions();
                        this.applyReplicaSetInstructions();
                        // // electing master pod from the available set
                        // const masterPod = this.podHelper.electMasterPod(this.workerStatus.availablePods);
                        // console.info('Electing master pod:', masterPod);
                        // // detecting any changes to the members so we can build the
                        // if (this.detectChanges()) {
                        //   // sending the changes into the members
                        //   await this.mongoManager.updateReplicaSetMembers(
                        //     this.workerStatus.changes.podsToAdd,
                        //     this.workerStatus.changes.podsToRemove,
                        //     false
                        //   );
                        // }
                        break;
                    default:
                        logger_1.Logger.warning(`Something seems odd as we did not find a use case in the status ${JSON.stringify(this.workerStatus.replicaSetStatus)}`);
                        // try {
                        //   while (this.mongoManager.client?.isConnected()) {
                        //     await this.mongoManager.client?.removeAllListeners();
                        //     await this.mongoManager.client?.close();
                        //   }
                        // } catch (error) {
                        //   this.finishWork(error, true);
                        // }
                        this.finishWork();
                        break;
                }
            }
            else {
                this.finishWork('Could not find a ReplicaSet Status in the system, closing connections until next loop', true);
            }
            logger_1.Logger.success(`Finished workloop waiting for ${this.config.loopSleepSeconds} seconds...`);
            this.finishWork();
        }
        catch (err) {
            this.finishWork(err, true);
        }
    }
    shutdown() {
        if (this.mongoClient)
            this.mongoClient.close();
        process.exit();
    }
    finishWork(error, closeConnection) {
        this.workerStatus.replicaSetStatusLastUpdate = -1;
        if (error) {
            console.error('Error in workloop:', error);
            if (this.mongoClient) {
                this.workerStatus.replicaSetStatusLastUpdate = -1;
                this.mongoClient.close();
            }
        }
        if (closeConnection && this.mongoClient)
            this.mongoClient.close();
        setTimeout(() => {
            this.doWork();
        }, this.loopSleepSeconds * 1000);
    }
    async initiateReplicaSet() {
        const primaryNode = this.podHelper.electMasterPod(this.workerStatus.pods);
        if (primaryNode) {
            logger_1.Logger.info(`Setting ${primaryNode} has the primary node`);
            const result = await this.mongoManager.initReplicaSet(this.workerStatus.pods);
            logger_1.Logger.info(`ReplicaSet initiation completed`, result);
        }
    }
    //#region private helpers
    detectChanges() {
        // resetting all of the changes
        this.workerStatus.init();
        // Adding new pods to the changes if they are not members yet
        this.workerStatus.availablePods.forEach((pod) => {
            const memberPod = this.workerStatus.members.find((f) => f.host === pod.host);
            if (!memberPod) {
                this.workerStatus.changes.podsToAdd.push(pod);
            }
        });
        this.workerStatus.members.forEach((member) => {
            const availablePod = this.workerStatus.availablePods.find((f) => f.host === member.host);
            if (!availablePod || !(availablePod === null || availablePod === void 0 ? void 0 : availablePod.isRunning)) {
                this.workerStatus.changes.podsToRemove.push(member);
            }
        });
        console.info(`Pods to Add: ${JSON.stringify(this.workerStatus.changes.podsToAdd.map((m) => m.host))}`);
        console.info(`Pods to Remove: ${JSON.stringify(this.workerStatus.changes.podsToRemove.map((m) => m.host))}`);
        this.workerStatus.hasChanges =
            this.workerStatus.changes.podsToAdd.length > 0 || this.workerStatus.changes.podsToRemove.length > 0;
        return this.workerStatus.hasChanges;
    }
    async mongoClientInit(host) {
        if (this.config.debug) {
            this.mongoClient = await this.mongoManager.init('127.0.0.1');
        }
        else {
            host = host ? host : this.config.k8sMongoServiceName;
            this.mongoClient = await this.mongoManager.init(host);
        }
        if (this.mongoClient) {
            this.connected = this.mongoClient.isConnected();
        }
        this.database = this.mongoManager.db;
        if (!this.mongoClient || !this.database) {
            throw new Error(`Could not connect to the server ${this.config.k8sMongoServiceName} and database ${this.config.mongoDatabase}`);
        }
    }
    matchReplicaSetStateMembersToPodMembers() {
        if (this.workerStatus.replicaSetStatus && this.workerStatus.replicaSetStatus.members) {
            let containsPrimary = false;
            this.workerStatus.replicaSetStatus.members.forEach((member) => {
                let existInPods;
                existInPods = -1;
                const memberHost = member.name.toLowerCase();
                const existingMember = this.workerStatus.pods.find((f) => { var _a; return ((_a = f.host) !== null && _a !== void 0 ? _a : '').toLowerCase() === memberHost; });
                if (existingMember) {
                    logger_1.Logger.information(`Mongo ReplicaSet Member ${member.name} was matched with ${existingMember.host} in the available pods: [ip] ${existingMember.ip}`);
                    existingMember.mongoNode = member;
                    existingMember.change = 'UNCHANGED';
                    existingMember.id = member._id;
                    existingMember.votes = 1;
                    existingMember.priority = 1;
                    existingMember.isPrimary = common_1.Common.isPrimary(member.stateStr);
                    if (existingMember.isPrimary) {
                        if (containsPrimary) {
                            existingMember.priority = 1;
                            logger_1.Logger.warning(`there was already a pod that was set to primary, setting this one with a lower priority for election`, existingMember);
                        }
                        else
                            existingMember.priority = 10;
                        containsPrimary = true;
                    }
                }
                else {
                    logger_1.Logger.information(`Mongo ReplicaSet Member ${member.name} was not matched with any pods, setting flag for removal`);
                    this.workerStatus.pods.push({
                        mongoNode: member,
                        host: member.name,
                        id: member._id,
                        isPrimary: member.stateStr === 'PRIMARY' ? true : false,
                        isRunning: false,
                        change: 'REMOVE',
                    });
                }
            });
            let primaryPod = this.workerStatus.pods.find((f) => f.isPrimary === true);
            if (!primaryPod) {
                primaryPod = this.getOlderPod(this.workerStatus.pods);
                primaryPod.isPrimary = true;
                if (primaryPod.change === 'UNCHANGED') {
                    primaryPod.change = 'ADD';
                }
            }
            console.info('Listing operations', this.workerStatus.pods);
        }
    }
    generateReplicaSetInstructions() {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        this.workerStatus.changes = new replica_changes_1.ReplicaChanges();
        if (this.workerStatus.pods && this.workerStatus.pods.length > 0) {
            const primaryPod = this.workerStatus.pods.find((f) => f.isPrimary);
            let electingNewPrimary = false;
            if ((primaryPod === null || primaryPod === void 0 ? void 0 : primaryPod.mongoNode) && primaryPod.isPrimary && primaryPod.change === 'REMOVE') {
                logger_1.Logger.blue(`Primary member ${primaryPod.host} is stepping down due to be removed, electing new primary member`);
                this.workerStatus.changes.isPrimarySteppingDown = true;
                this.workerStatus.changes.masterSteppingDown = primaryPod;
                this.workerStatus.changes.masterSteppingUp = this.getOlderPod(this.workerStatus.pods);
                if (this.workerStatus.changes.masterSteppingUp.change === 'UNCHANGED') {
                    this.workerStatus.changes.masterSteppingUp.change = 'ADD';
                }
                this.workerStatus.changes.masterSteppingUp.priority = 10;
                electingNewPrimary = true;
                logger_1.Logger.success(`Primary member ${this.workerStatus.changes.masterSteppingUp.host} is stepping up, congratulations`);
            }
            if (electingNewPrimary) {
                this.workerStatus.changes.changes.push({
                    _id: (_b = (_a = this.workerStatus.changes.masterSteppingUp) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : -1,
                    action: 'ADD',
                    host: (_d = (_c = this.workerStatus.changes.masterSteppingUp) === null || _c === void 0 ? void 0 : _c.host) !== null && _d !== void 0 ? _d : '',
                    isMaster: true,
                    priority: 10,
                    votes: 1,
                    isSteppingDown: false,
                });
                this.workerStatus.changes.changes.push({
                    _id: (_f = (_e = this.workerStatus.changes.masterSteppingDown) === null || _e === void 0 ? void 0 : _e.id) !== null && _f !== void 0 ? _f : -1,
                    action: 'REMOVE',
                    host: (_h = (_g = this.workerStatus.changes.masterSteppingDown) === null || _g === void 0 ? void 0 : _g.host) !== null && _h !== void 0 ? _h : '',
                    isMaster: true,
                    priority: 0,
                    votes: 0,
                    isSteppingDown: true,
                });
                this.workerStatus.pods.forEach((pod) => {
                    var _a, _b, _c;
                    if (pod.host !== ((_a = this.workerStatus.changes.masterSteppingUp) === null || _a === void 0 ? void 0 : _a.host) &&
                        pod.host !== ((_b = this.workerStatus.changes.masterSteppingDown) === null || _b === void 0 ? void 0 : _b.host) &&
                        pod.change !== 'UNCHANGED') {
                        this.workerStatus.changes.changes.push({
                            _id: -1,
                            action: pod.change === 'ADD' ? 'ADD' : 'REMOVE',
                            host: (_c = pod.host) !== null && _c !== void 0 ? _c : '',
                            isMaster: false,
                            priority: 1,
                            votes: 1,
                            isSteppingDown: false,
                        });
                    }
                });
            }
            else {
                this.workerStatus.pods.forEach((pod) => {
                    var _a;
                    if (pod.change !== 'UNCHANGED') {
                        this.workerStatus.changes.changes.push({
                            _id: -1,
                            action: pod.change === 'ADD' ? 'ADD' : 'REMOVE',
                            host: (_a = pod.host) !== null && _a !== void 0 ? _a : '',
                            isMaster: false,
                            priority: 1,
                            votes: 1,
                            isSteppingDown: false,
                        });
                    }
                });
            }
            logger_1.Logger.success(`Finished building the ReplicaSet changes:`, this.workerStatus.changes);
        }
    }
    async applyReplicaSetInstructions() {
        try {
            if (this.workerStatus.changes.hasChanges) {
                let rsConfig;
                logger_1.Logger.info('Changes detected, applying...');
                logger_1.Logger.info('Getting ReplicaSet current config');
                rsConfig = await this.mongoManager.getReplicaSetConfig();
                if (rsConfig) {
                    let max = Math.max.apply(null, rsConfig.members.map((m) => m._id));
                    logger_1.Logger.info(`ReplicaSet config was successfully retrieved, it contains ${rsConfig.members.length} members`);
                    if (this.workerStatus.changes.isPrimarySteppingDown) {
                        logger_1.Logger.info('Primary node is stepping down, electing new primary');
                        if (this.workerStatus.changes.changes[0]._id === -1) {
                            this.workerStatus.changes.changes[0]._id = ++max;
                        }
                        rsConfig.members.push({
                            _id: this.workerStatus.changes.changes[0]._id,
                            host: this.workerStatus.changes.changes[0].host,
                            priority: this.workerStatus.changes.changes[0].priority,
                            votes: this.workerStatus.changes.changes[0].votes,
                        });
                        logger_1.Logger.info('Reconfiguring ReplicaSet to add new Primary Node');
                        rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                        logger_1.Logger.success(`Added new primary: ${this.workerStatus.changes.changes[0].host}`);
                        if (rsConfig) {
                            logger_1.Logger.info('Removing old primary and waiting 20s for election');
                            setTimeout(async () => {
                                var _a, _b;
                                const oldMasterIndex = rsConfig === null || rsConfig === void 0 ? void 0 : rsConfig.members.findIndex((f) => f.host === this.workerStatus.changes.changes[1].host);
                                if (oldMasterIndex && oldMasterIndex > -1) {
                                    rsConfig === null || rsConfig === void 0 ? void 0 : rsConfig.members.splice(oldMasterIndex, 1);
                                }
                                logger_1.Logger.info('Closing current connection as primary node changed');
                                await ((_a = this.mongoManager.client) === null || _a === void 0 ? void 0 : _a.close());
                                await this.mongoClientInit();
                                logger_1.Logger.info('Getting the latest primary from the configuration');
                                logger_1.Logger.info(`Connecting to ${this.workerStatus.changes.changes[0].host} as this should be the master now`);
                                await this.mongoClientInit();
                                if ((_b = this.mongoManager.client) === null || _b === void 0 ? void 0 : _b.isConnected) {
                                    logger_1.Logger.info('Reconfiguring ReplicaSet to remove old Primary Node and waiting 20 seconds for the update');
                                    rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                    logger_1.Logger.success(`Removed old primary: ${this.workerStatus.changes.changes[1].host}`);
                                    setTimeout(() => {
                                        if (rsConfig) {
                                            let i = Math.max.apply(null, rsConfig.members.map((m) => { var _a; return (_a = m.priority) !== null && _a !== void 0 ? _a : 0; }));
                                            logger_1.Logger.info('Applying the rest of the changes');
                                            this.workerStatus.changes.changes.forEach(async (pod) => {
                                                if (pod.host !== this.workerStatus.changes.changes[0].host &&
                                                    pod.host !== this.workerStatus.changes.changes[1].host) {
                                                    if (rsConfig) {
                                                        if (pod.action === 'ADD') {
                                                            rsConfig.members.push({
                                                                _id: ++max,
                                                                host: pod.host,
                                                                priority: i,
                                                                votes: 1,
                                                            });
                                                            rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                                            logger_1.Logger.success(`Added member ${pod.host}`);
                                                        }
                                                        i++;
                                                        if (pod.action === 'REMOVE') {
                                                            if (rsConfig) {
                                                                const podToRemoveIndex = rsConfig.members.findIndex((f) => f.host === pod.host);
                                                                if (podToRemoveIndex > -1) {
                                                                    rsConfig.members.splice(podToRemoveIndex, 1);
                                                                    rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                                                    logger_1.Logger.success(`Removed member ${pod.host}`);
                                                                }
                                                            }
                                                        }
                                                        i++;
                                                    }
                                                }
                                            });
                                        }
                                    }, 20000);
                                }
                            }, 5000);
                        }
                    }
                    else {
                        if (rsConfig) {
                            let i = Math.max.apply(null, rsConfig.members.map((m) => { var _a; return (_a = m.priority) !== null && _a !== void 0 ? _a : 0; }));
                            logger_1.Logger.info('Applying changes, no primary node will be changed');
                            this.workerStatus.changes.changes.forEach(async (pod) => {
                                if (rsConfig) {
                                    if (pod.action === 'ADD') {
                                        rsConfig.members.push({
                                            _id: ++max,
                                            host: pod.host,
                                            priority: i,
                                            votes: 1,
                                        });
                                        rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                        logger_1.Logger.success(`Added member ${pod.host}`);
                                    }
                                    i++;
                                    if (pod.action === 'REMOVE') {
                                        if (rsConfig) {
                                            const podToRemoveIndex = rsConfig.members.findIndex((f) => f.host === pod.host);
                                            if (podToRemoveIndex > -1) {
                                                rsConfig.members.splice(podToRemoveIndex, 1);
                                                rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                                logger_1.Logger.success(`Removed member ${pod.host}`);
                                            }
                                        }
                                    }
                                    i++;
                                }
                            });
                        }
                    }
                }
                else {
                    this.finishWork('Could not find a valid ReplicaSet Config', true);
                }
            }
        }
        catch (error) {
            this.finishWork(error, true);
        }
    }
    getOlderPod(pods) {
        pods.sort((a, b) => {
            var _a, _b, _c, _d;
            const aDate = (_b = (_a = a.k8sPod) === null || _a === void 0 ? void 0 : _a.metadata) === null || _b === void 0 ? void 0 : _b.creationTimestamp;
            const bDate = (_d = (_c = b.k8sPod) === null || _c === void 0 ? void 0 : _c.metadata) === null || _d === void 0 ? void 0 : _d.creationTimestamp;
            if (!aDate < !bDate)
                return -1;
            if (!aDate > !bDate)
                return 1;
            return 0; // Shouldn't get here... all pods should have different dates
        });
        return pods[0];
    }
    removePortFromHost(str) {
        let result = str;
        const portStr = `:${this.config.mongoPort}`;
        if (result.includes(portStr)) {
            const indexOf = result.indexOf(portStr);
            result = result.substring(0, indexOf);
        }
        return result;
    }
}
exports.Worker = Worker;
//# sourceMappingURL=worker.js.map