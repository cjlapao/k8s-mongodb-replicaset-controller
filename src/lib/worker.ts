import { PodHelper } from './helpers/pods';
import { WorkerStatus } from './worker-status';
import { MongoClient, Db } from 'mongodb';
import { V1PodList, V1Pod } from '@kubernetes/client-node';
import { lookup as _lookup } from 'dns';
import { hostname } from 'os';
import { promisify } from 'util';
import { MongoManager } from './mongo';

import { DateTime } from 'luxon';
import ip from 'ip';

// import { getClient, replSetGetStatus, initReplSet, addNewReplSetMembers, isInReplSet, MongoManager } from './mongo';
// import { init as _init, getMongoPods } from './k8s_old';
import { Config } from './config';
// import { loopSleepSeconds } from './config_old';
import { K8sClient } from './k8s';
import { PodMember } from './models/PodMember';
import { ReplicaSetStatus } from './models/replicaset-config';

export class Worker {
  status: WorkerStatus;
  config: Config;
  loopSleepSeconds: number;
  unhealthySeconds: number;
  hostIp: string | undefined;
  hostIpAndPort: string | undefined;
  k8sClient: K8sClient;
  mongoManager: MongoManager;
  mongoClient?: MongoClient;
  database?: Db;
  pods?: V1PodList;
  podHelper: PodHelper;
  connected: boolean;

  constructor() {
    this.config = new Config();
    this.loopSleepSeconds = this.config.loopSleepSeconds;
    this.unhealthySeconds = this.config.unhealthySeconds;
    this.k8sClient = new K8sClient(this.config);
    this.mongoManager = new MongoManager(this.config);
    this.status = new WorkerStatus();
    this.podHelper = new PodHelper(this.config);
    this.connected = false;
  }

  public async init() {
    // Borrowed from here: http://stackoverflow.com/questions/3653065/get-local-ip-address-in-node-js
    const hostName = hostname();
    const lookup = promisify(_lookup);
    try {
      const hostLookupIp = await lookup(hostName);
      this.hostIp = hostLookupIp.address;
      this.hostIpAndPort = this.hostIp + ':' + this.config.mongoPort;
    } catch (err) {
      return Promise.reject(err);
    }

    try {
      await this.k8sClient.init();
      await this.mongoClientInit();
    } catch (err) {
      return Promise.reject(err);
    }

    return;
  }

  public async doWork() {
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
    } catch (err) {
      return this.finishWork(err);
    }

    if (!this.pods?.items) {
      this.status.members = [];
      return this.finishWork('There was an error collecting the pods');
    }

    try {
      this.status.availablePods = [];
      // Lets remove any pods that aren't running or haven't been assigned an IP address yet
      for (let i = this.pods.items.length - 1; i >= 0; i--) {
        const pod = this.pods.items[i];
        if (pod.status?.phase !== 'Running' || !pod.status?.podIP) {
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
    } catch (error) {
      console.error('There was an error processing live pods', error);
      this.finishWork(error);
    }

    try {
      let replicaSetStatus: ReplicaSetStatus;
      try {
        replicaSetStatus = await this.mongoManager.getReplicaSetStatus();
      } catch (error) {
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
          console.log(
            `ReplicaSet is initiated and healthy, found ${replicaSetStatus?.members?.length} node in replica members`
          );
          // converting all members to PodMembers
          this.status.members = [];
          console.info(`Converting member hosts to pods:`);
          // console.debug(replicaSetStatus);
          replicaSetStatus.members?.forEach((member) => {
            const m = member as any;
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
            await this.mongoManager.updateReplicaSetMembers(
              this.status.changes.podsToAdd,
              this.status.changes.podsToRemove,
              false
            );
          }
          break;
        default:
          console.log(
            `Something seems odd as we did not find a use case in the status ${JSON.stringify(replicaSetStatus)}`
          );
          this.finishWork(null, true);
          break;
      }
      this.finishWork();
    } catch (err) {
      this.finishWork(err);
    }
  }

  public shutdown() {
    if (this.mongoClient) this.mongoClient.close();
    process.exit();
  }

  public finishWork(error?: any, closeConnection?: boolean) {
    if (error) {
      console.error('Error in workloop:', error);
      if (this.mongoClient) this.mongoClient.close();
    }

    if (closeConnection && this.mongoClient) this.mongoClient.close();

    setTimeout(() => {
      this.doWork();
    }, this.loopSleepSeconds * 1000);
  }

  public async initiateReplicaSet() {
    console.log(
      'pods to elect',
      this.pods?.items.map((c) => c.metadata?.name)
    );
    const masterAddress = this.podHelper.electMasterPod(this.status.availablePods);
    if (masterAddress) {
      console.log(`And the winner is -> ${masterAddress}`);
      const result = await this.mongoManager.initReplicaSet(masterAddress);
      console.log(result);
    }
  }

  //#region private helpers

  private detectChanges(): boolean {
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
      if (!availablePod || !availablePod?.isRunning) {
        this.status.changes.podsToRemove.push(member);
      }
    });

    console.info(`Pods to Add: ${JSON.stringify(this.status.changes.podsToAdd.map((m) => m.host))}`);
    console.info(`Pods to Remove: ${JSON.stringify(this.status.changes.podsToRemove.map((m) => m.host))}`);
    this.status.hasChanges = this.status.changes.podsToAdd.length > 0 || this.status.changes.podsToRemove.length > 0;
    return this.status.hasChanges;
  }

  private async mongoClientInit() {
    if (this.config.debug) {
      this.mongoClient = await this.mongoManager.init('127.0.0.1');
    } else {
      this.mongoClient = await this.mongoManager.init(this.config.k8sMongoServiceName);
    }
    if (this.mongoClient) {
      this.connected = this.mongoClient.isConnected();
    }
    this.database = this.mongoManager.db;
    if (!this.mongoClient || !this.database) {
      throw new Error(
        `Could not connect to the server ${this.config.k8sMongoServiceName} and database ${this.config.mongoDatabase}`
      );
    }
  }

  //#endregion
}
