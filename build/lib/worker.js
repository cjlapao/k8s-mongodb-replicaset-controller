"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
const pods_1 = require("./helpers/pods");
const worker_status_1 = require("./worker-status");
const dns_1 = require("dns");
const os_1 = require("os");
const util_1 = require("util");
const mongo_1 = require("./mongo");
// import { getClient, replSetGetStatus, initReplSet, addNewReplSetMembers, isInReplSet, MongoManager } from './mongo';
// import { init as _init, getMongoPods } from './k8s_old';
const config_1 = require("./config");
// import { loopSleepSeconds } from './config_old';
const k8s_1 = require("./k8s");
class Worker {
    constructor() {
        this.config = new config_1.Config();
        this.loopSleepSeconds = this.config.loopSleepSeconds;
        this.unhealthySeconds = this.config.unhealthySeconds;
        this.k8sClient = new k8s_1.K8sClient(this.config);
        this.mongoManager = new mongo_1.MongoManager(this.config);
        this.status = new worker_status_1.WorkerStatus();
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
        var _a, _b, _c, _d, _e;
        if (!this.connected) {
            this.mongoClientInit();
        }
        const now = new Date();
        const nowPlusOne = now.addHours(1);
        console.info(`start time ${now.getTime()} => in one hour ${nowPlusOne.getTime()}`);
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
            this.status.members = [];
            return this.finishWork('There was an error collecting the pods');
        }
        try {
            this.status.availablePods = [];
            // Lets remove any pods that aren't running or haven't been assigned an IP address yet
            for (let i = this.pods.items.length - 1; i >= 0; i--) {
                const pod = this.pods.items[i];
                if (((_b = pod.status) === null || _b === void 0 ? void 0 : _b.phase) !== 'Running' || !((_c = pod.status) === null || _c === void 0 ? void 0 : _c.podIP)) {
                    this.pods.items.splice(i, 1);
                }
            }
            this.pods.items.forEach((pod) => {
                this.status.availablePods.push(this.podHelper.toPodMember(pod));
            });
            console.info('Available Pods:');
            this.status.availablePods.forEach((apod) => {
                console.info(`\tPod: ${apod.host} -> ${apod.ip}`);
            });
            if (!this.status.availablePods.length) {
                return this.finishWork('No pods are currently running, probably just give them some time.', true);
            }
        }
        catch (error) {
            console.error('There was an error processing live pods', error);
            this.finishWork(error);
        }
        try {
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
            this.status.set = replicaSetStatus.set;
            this.status.lastStatusCode = replicaSetStatus.code;
            switch (replicaSetStatus.code) {
                case 94:
                    await this.initiateReplicaSet();
                    if (this.pods.items.length > 1) {
                        console.log("Adding the other pod's to the replica set");
                    }
                    break;
                case 0:
                    console.log(`ReplicaSet is initiated and healthy, found ${(_d = replicaSetStatus === null || replicaSetStatus === void 0 ? void 0 : replicaSetStatus.members) === null || _d === void 0 ? void 0 : _d.length} node in replica members`);
                    // converting all members to PodMembers
                    this.status.members = [];
                    console.info(`Converting member hosts to pods:`);
                    // console.debug(replicaSetStatus);
                    (_e = replicaSetStatus.members) === null || _e === void 0 ? void 0 : _e.forEach((member) => {
                        const m = member;
                        console.info(`Member: ${m.name}`);
                        this.status.members.push({
                            host: m.name,
                            isPrimary: m.stateStr.toLowerCase() === 'primary',
                        });
                    });
                    // electing master pod from the available set
                    const masterPod = this.podHelper.electMasterPod(this.status.availablePods);
                    console.info('Electing master pod:', masterPod);
                    // detecting any changes to the members so we can build the
                    if (this.detectChanges()) {
                        // sending the changes into the members
                        await this.mongoManager.updateReplicaSetMembers(this.status.changes.podsToAdd, this.status.changes.podsToRemove, false);
                    }
                    break;
                default:
                    console.log(`Something seems odd as we did not find a use case in the status ${JSON.stringify(replicaSetStatus)}`);
                    this.finishWork(null, true);
                    break;
            }
            this.finishWork();
        }
        catch (err) {
            this.finishWork(err);
        }
    }
    shutdown() {
        if (this.mongoClient)
            this.mongoClient.close();
        process.exit();
    }
    finishWork(error, closeConnection) {
        if (error) {
            console.error('Error in workloop:', error);
            if (this.mongoClient)
                this.mongoClient.close();
        }
        if (closeConnection && this.mongoClient)
            this.mongoClient.close();
        setTimeout(() => {
            this.doWork();
        }, this.loopSleepSeconds * 1000);
    }
    async initiateReplicaSet() {
        var _a;
        console.log('pods to elect', (_a = this.pods) === null || _a === void 0 ? void 0 : _a.items.map((c) => { var _a; return (_a = c.metadata) === null || _a === void 0 ? void 0 : _a.name; }));
        const masterAddress = this.podHelper.electMasterPod(this.status.availablePods);
        if (masterAddress) {
            console.log(`And the winner is -> ${masterAddress}`);
            const result = await this.mongoManager.initReplicaSet(masterAddress);
            console.log(result);
        }
    }
    //#region private helpers
    detectChanges() {
        // resetting all of the changes
        this.status.init();
        // Adding new pods to the changes if they are not members yet
        this.status.availablePods.forEach((pod) => {
            const memberPod = this.status.members.find((f) => f.host === pod.host);
            if (!memberPod) {
                this.status.changes.podsToAdd.push(pod);
            }
        });
        this.status.members.forEach((member) => {
            const availablePod = this.status.availablePods.find((f) => f.host === member.host);
            if (!availablePod || !(availablePod === null || availablePod === void 0 ? void 0 : availablePod.isRunning)) {
                this.status.changes.podsToRemove.push(member);
            }
        });
        console.info(`Pods to Add: ${JSON.stringify(this.status.changes.podsToAdd.map((m) => m.host))}`);
        console.info(`Pods to Remove: ${JSON.stringify(this.status.changes.podsToRemove.map((m) => m.host))}`);
        this.status.hasChanges = this.status.changes.podsToAdd.length > 0 || this.status.changes.podsToRemove.length > 0;
        return this.status.hasChanges;
    }
    async mongoClientInit() {
        if (this.config.debug) {
            this.mongoClient = await this.mongoManager.init('127.0.0.1');
        }
        else {
            this.mongoClient = await this.mongoManager.init(this.config.k8sMongoServiceName);
        }
        if (this.mongoClient) {
            this.connected = this.mongoClient.isConnected();
        }
        this.database = this.mongoManager.db;
        if (!this.mongoClient || !this.database) {
            throw new Error(`Could not connect to the server ${this.config.k8sMongoServiceName} and database ${this.config.mongoDatabase}`);
        }
    }
}
exports.Worker = Worker;
//# sourceMappingURL=worker.js.map