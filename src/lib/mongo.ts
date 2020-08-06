import { PodHelper } from './helpers/pods';
import { ReplicaSetConfig, ReplicaSetMember, CertificatesStore, ReplicaSetStatus } from './models/replicaset-config';
import { Config } from './config';
import { promisify, isRegExp } from 'util';
import { MongoClient, MongoClientOptions, Db } from 'mongodb';
import { readFile, stat } from 'fs';
import { PodMember } from './models/PodMember';

export class MongoManager {
  private localhost = '127.0.0.1';
  private certificates?: CertificatesStore;
  public client?: MongoClient;
  public db?: Db;

  constructor(private config: Config) {}

  public async init(host: string) {
    host = host || this.config.k8sMongoServiceName || this.localhost;
    await this.getClient(host);
    await this.getDatabase(this.config.mongoDatabase);
    return this.client;
  }

  public async getReplicaSetConfig() {
    if (this.db) {
      return await this.db
        .admin()
        .command({ replSetGetConfig: 1 }, {})
        .then((results) => {
          return results.config as ReplicaSetConfig;
        });
    }
    return {} as ReplicaSetConfig;
  }

  public async getReplicaSetStatus(): Promise<ReplicaSetStatus> {
    let status: ReplicaSetStatus;
    if (this.db) {
      try {
        console.log('Checking replicaSet status');
        const result = await this.db.admin().command({ replSetGetStatus: {} }, {});
        status = {
          set: result.set,
          ok: result.ok,
          code: 0,
          members: result.members ? result.members : [],
        };
        return status;
      } catch (err) {
        status = {
          ok: 0,
          code: err.code,
        };
        return status;
      }
    }
    return (status = {
      ok: 0,
      code: -1,
    });
  }

  public async initReplicaSet(masterAddress: string) {
    if (this.db) {
      if (!masterAddress) {
        throw new Error(`The master node address ${masterAddress} is invalid`);
      }

      try {
        await this.db.admin().command({ replSetInitiate: {} }, {});

        // We need to hack in the fix where the host is set to the hostname which isn't reachable from other hosts
        const rsConfig = await this.getReplicaSetConfig();

        console.info('initial rsConfig is', rsConfig);
        rsConfig.configsvr = this.config.isConfigRS;
        rsConfig.members[0].host = masterAddress;

        const times = 20;
        const interval = 500;
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

        let tries = 0;
        while (tries < times) {
          try {
            return await this.reconfigReplicaSet(rsConfig, false);
          } catch (err) {
            await wait(interval);
            tries++;
            if (tries >= times) return Promise.reject(err);
          }
        }
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }

  public async updateReplicaSetMembers(toAdd: PodMember[], toRemove: PodMember[], force: boolean) {
    try {
      const rsConfig = await this.getReplicaSetConfig();
      console.log(rsConfig);
      if (rsConfig.members) {
        const newPrimaryNode = this.electMasterMember(rsConfig.members, toAdd, toRemove);
        await this.addMembersToReplicaSetConfig(rsConfig, toAdd, newPrimaryNode);
        await this.removeMembersToReplicaSetConfig(rsConfig, toRemove);
      }
    } catch (error) {
      Promise.reject(error);
    }
  }

  private async addMembersToReplicaSetConfig(
    rsConfig: ReplicaSetConfig,
    pods: PodMember[],
    masterNode: ReplicaSetMember
  ) {
    if (rsConfig.members) {
      let max = 0;
      max = this.getMaxId(rsConfig.members);
      pods.forEach(async (pod) => {
        if (pod.host) {
          if (pod.host === masterNode.host) pod.priority = masterNode.priority;
          const podInConfig = rsConfig.members?.find((f) => f.host === pod.host);
          if (!podInConfig) {
            const newMemberCfg: ReplicaSetMember = {
              _id: ++max,
              host: pod.host,
              priority: pod.priority ?? 1,
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

  private async removeMembersToReplicaSetConfig(rsConfig: ReplicaSetConfig, pods: PodMember[]) {
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

  private async reconfigReplicaSet(replSetConfig: ReplicaSetConfig, force?: boolean) {
    if (this.db) {
      if (!force) force = false;
      else force = true;
      replSetConfig.version++;
      await this.db.admin().command({ replSetReconfig: replSetConfig, force }, {});
      console.info(`updating config with new configuration`);
      replSetConfig = await this.getReplicaSetConfig();
      console.debug(`rsConfig:`, replSetConfig);
    }
  }

  private electMasterMember(existing: ReplicaSetMember[], toAdd: PodMember[], toRemove: PodMember[]) {
    const combinedList: ReplicaSetMember[] = [];
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

  public getDatabase(databaseName: string) {
    if (this.client) {
      this.db = this.client.db(databaseName);
    }
    return this.db;
  }

  public async getClient(host: string) {
    host = host || this.config.k8sMongoServiceName || this.localhost;
    const options: MongoClientOptions = {
      authSource: this.config.mongoAuthSource,
      authMechanism: this.config.mongoUsername ? this.config.authMechanism : '',
      ssl: this.config.mongoSSL,
      sslPass: this.config.mongoTLSPassword,
      checkServerIdentity: this.config.mongoTLSServerIdentityCheck,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    };
    try {
      if (this.config.mongoTLS) {
        this.certificates = await this.getTLSCertificates();
        if (this.certificates) {
          Object.assign(options, this.certificates);
        }
      }

      const uri = await this.getConnectionURI(host);
      this.client = new MongoClient(uri, options);
      return this.client.connect();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async getConnectionURI(host: string) {
    let credentials = '';
    if (this.config.mongoUsername) {
      const username = encodeURIComponent(this.config.mongoUsername);
      const password = encodeURIComponent(this.config.mongoPassword ? this.config.mongoPassword : '');
      credentials = `${username}:${password}@`;
    }

    return `mongodb://${credentials}${host}:${this.config.mongoPort}/${this.config.mongoDatabase}`;
  }

  private async getTLSCertificates(): Promise<CertificatesStore> {
    const fr = promisify(readFile);

    try {
      const tasks: Promise<Buffer>[] = [];
      if (this.config.mongoTLSCert) tasks[0] = fr(this.config.mongoTLSCert);
      if (this.config.mongoTLSKey) tasks[1] = fr(this.config.mongoTLSKey);
      if (this.config.mongoTLSCA) tasks[2] = fr(this.config.mongoTLSCA);
      if (this.config.mongoTLSCRL) tasks[3] = fr(this.config.mongoTLSCRL);

      const files = await Promise.all(tasks);

      const certs: CertificatesStore = {
        sslCA: undefined,
        sslCRL: undefined,
        sslCert: undefined,
        sslKey: undefined,
      };
      if (files[0]) certs.sslCert = files[0];
      if (files[1]) certs.sslKey = files[1];
      if (files[2]) certs.sslCA = files[2];
      if (files[3]) certs.sslCRL = files[3];
      return certs;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private getMemberWithMostPriority(pods: ReplicaSetMember[]) {
    pods.sort((a, b) => {
      const aPriority = a.priority ?? 0;
      const bPriority = b.priority ?? 0;
      if (!aPriority < !bPriority) return -1;
      if (!aPriority > !bPriority) return 1;
      return 0; // Shouldn't get here... all pods should have different dates
    });
    return pods[0];
  }

  private getMaxId(nodes: ReplicaSetMember[]) {
    let max = 0;
    if (nodes.length > 0) {
      max = Math.max.apply(
        null,
        nodes?.map((m) => m._id)
      );
    }
    return max;
  }
}
