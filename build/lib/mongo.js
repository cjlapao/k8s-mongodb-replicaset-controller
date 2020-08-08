"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoManager = void 0;
const util_1 = require("util");
const mongodb_1 = require("mongodb");
const fs_1 = require("fs");
const logger_1 = require("./services/logger");
class MongoManager {
    constructor(config) {
        this.config = config;
        this.localhost = '127.0.0.1';
    }
    async init(host) {
        host = host || this.config.k8sMongoServiceName || this.localhost;
        await this.getClient(host);
        await this.getDatabase(this.config.mongoDatabase);
        return this.client;
    }
    async getReplicaSetConfig() {
        if (this.db) {
            return await this.db
                .admin()
                .command({ replSetGetConfig: 1 }, { readPreference: 'primary' })
                .then((results) => {
                return results.config;
            });
        }
    }
    async getReplicaSetStatus() {
        let status;
        if (this.db) {
            try {
                console.log('Checking replicaSet status');
                const result = await this.db.admin().command({ replSetGetStatus: {} }, { readPreference: 'primary' });
                status = {
                    set: result.set,
                    ok: result.ok,
                    code: 0,
                    members: result.members ? result.members : [],
                };
                return status;
            }
            catch (error) {
                if (error.code && error.code === 94) {
                    status = {
                        ok: 0,
                        code: error.code,
                    };
                }
                else {
                    logger_1.Logger.error(`There was an error collecting the ReplicaSetStatus`, error);
                    status = {
                        ok: -1,
                        code: error.code,
                    };
                }
                if (error.MongoError && error.MongoError.includes('Topology is closed, please connect')) {
                    await this.init(this.config.k8sMongoServiceName);
                }
                return status;
            }
        }
    }
    async initReplicaSet(pods) {
        if (this.db) {
            if (!pods || pods.length === 0) {
                throw new Error(`there is no pods to initiate`);
            }
            try {
                // building the initiate command
                const members = [];
                let i = 0;
                pods.forEach((pod) => {
                    logger_1.Logger.info(`Adding ${pod.host} to the initial ReplicaSet`);
                    members.push({
                        _id: i,
                        host: pod.host,
                    });
                    i++;
                });
                const config = {
                    _id: 'rs0',
                    members,
                };
                await this.db.admin().command({ replSetInitiate: config }, { readPreference: 'primary' });
                // We need to hack in the fix where the host is set to the hostname which isn't reachable from other hosts
                return await this.getReplicaSetConfig();
                // if (rsConfig) {
                //   Logger.info(`Initial ReplicaSet config:`, rsConfig);
                //   rsConfig.configsvr = this.config.isConfigRS;
                //   rsConfig.members[0].host = masterAddress;
                //   return await this.reconfigReplicaSet(rsConfig, false);
                // }
            }
            catch (err) {
                return Promise.reject(err);
            }
        }
    }
    async updateReplicaSetMembers(toAdd, toRemove, force) {
        try {
            const rsConfig = await this.getReplicaSetConfig();
            console.log(rsConfig);
            if (rsConfig) {
                if (rsConfig.members) {
                    const newPrimaryNode = this.electMasterMember(rsConfig.members, toAdd, toRemove);
                    await this.addMembersToReplicaSetConfig(rsConfig, toAdd, newPrimaryNode);
                    await this.removeMembersToReplicaSetConfig(rsConfig, toRemove);
                }
            }
        }
        catch (error) {
            Promise.reject(error);
        }
    }
    async addMembersToReplicaSetConfig(rsConfig, pods, masterNode) {
        if (rsConfig.members) {
            let max = 0;
            max = this.getMaxId(rsConfig.members);
            pods.forEach(async (pod) => {
                var _a, _b;
                if (pod.host) {
                    if (pod.host === masterNode.host)
                        pod.priority = masterNode.priority;
                    const podInConfig = (_a = rsConfig.members) === null || _a === void 0 ? void 0 : _a.find((f) => f.host === pod.host);
                    if (!podInConfig) {
                        const newMemberCfg = {
                            _id: ++max,
                            host: pod.host,
                            priority: (_b = pod.priority) !== null && _b !== void 0 ? _b : 1,
                            votes: 1,
                        };
                        rsConfig.members.push(newMemberCfg);
                        console.info(`Adding member to the replica:`, newMemberCfg);
                        await this.reconfigReplicaSet(rsConfig);
                    }
                }
            });
        }
    }
    async removeMembersToReplicaSetConfig(rsConfig, pods) {
        console.debug(rsConfig.members);
        pods.forEach(async (pod) => {
            if (pod.host && rsConfig.members) {
                console.debug(pod);
                const podInConfigIndex = rsConfig.members.findIndex((f) => f.host === pod.host);
                console.debug(podInConfigIndex);
                if (podInConfigIndex > -1) {
                    console.info(`removing member to the replica:`, rsConfig.members[podInConfigIndex]);
                    rsConfig.members.splice(podInConfigIndex, 1);
                    await this.reconfigReplicaSet(rsConfig);
                }
            }
        });
    }
    async reconfigReplicaSet(replSetConfig, force) {
        var _a;
        if (this.db) {
            try {
                const times = 20;
                const interval = 500;
                const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
                let tries = 0;
                while (tries < times) {
                    try {
                        if (!force)
                            force = false;
                        else
                            force = true;
                        if (replSetConfig) {
                            replSetConfig.version++;
                            await this.db.admin().command({ replSetReconfig: replSetConfig, force }, { readPreference: 'primary' });
                            replSetConfig = await this.getReplicaSetConfig();
                            return replSetConfig;
                        }
                    }
                    catch (error) {
                        logger_1.Logger.error('error 0', error);
                        if (error.MongoError.includes('PRIMARY. Current state SECONDARY')) {
                            await ((_a = this.client) === null || _a === void 0 ? void 0 : _a.close());
                            this.client = await this.init(this.config.k8sMongoServiceName);
                        }
                        await wait(interval);
                        tries++;
                        if (tries >= times)
                            return Promise.reject(error);
                    }
                }
            }
            catch (error) {
                logger_1.Logger.error('error 1', error);
                return Promise.reject(error);
            }
        }
    }
    electMasterMember(existing, toAdd, toRemove) {
        const combinedList = [];
        existing.forEach((e) => {
            combinedList.push(e);
        });
        let max = this.getMaxId(combinedList);
        const actualMasterPod = this.getMemberWithMostPriority(existing);
        toAdd.forEach((pod) => {
            if (pod.host) {
                combinedList.push({
                    _id: ++max,
                    host: pod.host,
                    priority: 1,
                    votes: 1,
                });
            }
        });
        toRemove.forEach((pod) => {
            if (pod.host) {
                const podInConfigIndex = combinedList.findIndex((f) => f.host === pod.host);
                if (podInConfigIndex > -1) {
                    combinedList.splice(podInConfigIndex, 1);
                }
            }
        });
        if (actualMasterPod.host !== combinedList[0].host) {
            // every pod will vote for the master pod, fair :)
            combinedList[0].priority = existing.length + 1;
            const isStillMember = combinedList.findIndex((f) => f.host === actualMasterPod.host);
            if (isStillMember && isStillMember > 0) {
                combinedList[isStillMember].priority = 0;
            }
        }
        const newMasterPod = this.getMemberWithMostPriority(combinedList);
        return newMasterPod;
    }
    getDatabase(databaseName) {
        if (this.client) {
            this.db = this.client.db(databaseName);
        }
        return this.db;
    }
    async getClient(host) {
        host = host || this.config.k8sMongoServiceName || this.localhost;
        const options = {
            authSource: this.config.mongoAuthSource,
            authMechanism: this.config.mongoUsername ? this.config.authMechanism : '',
            ssl: this.config.mongoSSL,
            sslPass: this.config.mongoTLSPassword,
            checkServerIdentity: this.config.mongoTLSServerIdentityCheck,
            useNewUrlParser: true,
            useUnifiedTopology: true,
            reconnectInterval: 3000,
            poolSize: 10,
            bufferMaxEntries: 0,
            reconnectTries: Number.MAX_VALUE,
        };
        try {
            if (this.config.mongoTLS) {
                this.certificates = await this.getTLSCertificates();
                if (this.certificates) {
                    Object.assign(options, this.certificates);
                }
            }
            const uri = await this.getConnectionURI(host);
            this.client = new mongodb_1.MongoClient(uri, options);
            return this.client.connect();
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    async getConnectionURI(host) {
        let credentials = '';
        if (this.config.mongoUsername) {
            const username = encodeURIComponent(this.config.mongoUsername);
            const password = encodeURIComponent(this.config.mongoPassword ? this.config.mongoPassword : '');
            credentials = `${username}:${password}@`;
        }
        return `mongodb://${credentials}${host}:${this.config.mongoPort}/${this.config.mongoDatabase}`;
    }
    async getTLSCertificates() {
        const fr = util_1.promisify(fs_1.readFile);
        try {
            const tasks = [];
            if (this.config.mongoTLSCert)
                tasks[0] = fr(this.config.mongoTLSCert);
            if (this.config.mongoTLSKey)
                tasks[1] = fr(this.config.mongoTLSKey);
            if (this.config.mongoTLSCA)
                tasks[2] = fr(this.config.mongoTLSCA);
            if (this.config.mongoTLSCRL)
                tasks[3] = fr(this.config.mongoTLSCRL);
            const files = await Promise.all(tasks);
            const certs = {
                sslCA: undefined,
                sslCRL: undefined,
                sslCert: undefined,
                sslKey: undefined,
            };
            if (files[0])
                certs.sslCert = files[0];
            if (files[1])
                certs.sslKey = files[1];
            if (files[2])
                certs.sslCA = files[2];
            if (files[3])
                certs.sslCRL = files[3];
            return certs;
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    getMemberWithMostPriority(pods) {
        pods.sort((a, b) => {
            var _a, _b;
            const aPriority = (_a = a.priority) !== null && _a !== void 0 ? _a : 0;
            const bPriority = (_b = b.priority) !== null && _b !== void 0 ? _b : 0;
            if (!aPriority < !bPriority)
                return -1;
            if (!aPriority > !bPriority)
                return 1;
            return 0; // Shouldn't get here... all pods should have different dates
        });
        return pods[0];
    }
    getMaxId(nodes) {
        let max = 0;
        if (nodes.length > 0) {
            max = Math.max.apply(null, nodes === null || nodes === void 0 ? void 0 : nodes.map((m) => m._id));
        }
        return max;
    }
}
exports.MongoManager = MongoManager;
//# sourceMappingURL=mongo.js.map