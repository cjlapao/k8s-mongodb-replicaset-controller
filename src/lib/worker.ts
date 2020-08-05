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

  constructor() {
    this.config = new Config();
    this.loopSleepSeconds = this.config.loopSleepSeconds;
    this.unhealthySeconds = this.config.unhealthySeconds;
    this.k8sClient = new K8sClient(this.config);
    this.mongoManager = new MongoManager(this.config);
    this.status = new WorkerStatus();
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
      if (this.config.debug) {
        this.mongoClient = await this.mongoManager.init('127.0.0.1');
      } else {
        this.mongoClient = await this.mongoManager.init(this.config.k8sMongoServiceName);
      }
      this.database = this.mongoManager.db;
      if (!this.mongoClient || !this.database) {
        throw new Error(
          `Could not connect to the server ${this.config.k8sMongoServiceName} and database ${this.config.mongoDatabase}`
        );
      }
    } catch (err) {
      return Promise.reject(err);
    }

    return;
  }

  public async doWork() {
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
        this.status.availablePods.push(this.toPodMember(pod));
      });

      if (!this.status.availablePods.length) {
        return this.finishWork('No pods are currently running, probably just give them some time.');
      }
    } catch (error) {
      console.error('There was an error processing live pods', error);
      this.finishWork(error);
    }

    try {
      const status = await this.mongoManager.getReplicaSetStatus();
      this.status.set = status?.set;
      this.status.lastStatusCode = status?.code;
      switch (status?.code) {
        case 94:
          await this.initiateReplicaSet();
          if (this.pods.items.length > 1) {
            console.log("Adding the other pod's to the replica set");
          }
          break;
        case 0:
          // converting all members to PodMembers
          this.status.members = [];
          status.members?.forEach((member) => {
            const m = member as any;
            this.status.members.push({
              host: m.name,
              isPrimary: m.stateStr.toLowerCase() === 'primary',
            });
          });
          if (this.detectChanges()) {
            this.mongoManager.UpdateReplicaSetMembers(
              this.status.changes.podsToAdd,
              this.status.changes.podsToRemove,
              false
            );
          }
          console.log(`ReplicaSet is initiated and healthy, found ${status?.members?.length} node in replica members`);
          break;
        default:
          console.log(`Something seems odd as we did not find a use case in the status ${JSON.stringify(status)}`);
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
    const masterAddress = this.electMasterPod();
    if (masterAddress) {
      console.log(`And the winner is -> ${masterAddress}`);
      const result = await this.mongoManager.initReplicaSet(masterAddress);
      console.log(result);
    }
  }

  //#region private helpers

  private detectChanges(): boolean {
    // reseting all of the changes
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

    console.log(`Pods to Add: ${JSON.stringify(this.status.changes.podsToAdd.map((m) => m.host))}`);
    console.log(`Pods to remove: ${JSON.stringify(this.status.changes.podsToRemove.map((m) => m.host))}`);
    this.status.hasChanges = this.status.changes.podsToAdd.length > 0 || this.status.changes.podsToRemove.length > 0;
    return this.status.hasChanges;
  }

  /**
   * Electing a master pod to rule them all, based on their creation date
   * we will elect as primary the oldest of them all
   * @param {*} pods
   * @returns {string} address - Kubernetes pod's address
   */
  private electMasterPod() {
    this.status.availablePods.sort((a, b) => {
      const aDate = a.pod?.metadata?.creationTimestamp;
      const bDate = b.pod?.metadata?.creationTimestamp;
      if (!aDate < !bDate) return -1;
      if (!aDate > !bDate) return 1;
      return 0; // Shouldn't get here... all pods should have different dates
    });
    console.log(`${this.pods?.items[0].metadata?.name} -> ${this.pods?.items[0].metadata?.creationTimestamp}`);
    return this.getPodAddress(this.pods?.items[0]);
  }

  /**
   * Gets the pod's address. It can be either in the form of
   * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'.
   * If those are not set, then simply the pod's IP is returned.
   * @param {*} pod Kubernetes Pod
   * @returns string - Kubernetes stateful set address or pod's IP
   */
  private getPodAddress(pod: V1Pod | undefined): string {
    let address: any;
    address = this.getPodStableNetworkAddressAndPort(pod);
    if (!address) {
      console.warn(`Could not find the stable network address for the pod ${pod?.metadata?.name}`);
      address = this.getPodIpAddressAndPort(pod);
    }

    return address;
  }

  /**
   * Gets the pod's IP Address and the mongo port
   * @param pod this is the Kubernetes pod, containing the info.
   * @returns string - podIp the pod's IP address with the port from config attached at the end. Example
   * WWW.XXX.YYY.ZZZ:27017. It returns undefined, if the data is insufficient to retrieve the IP address.
   */
  private getPodIpAddressAndPort(pod: V1Pod | undefined): string | undefined {
    if (!pod || !pod.status || !pod.status.podIP) return;

    return `${pod.status.podIP}:${this.config.mongoPort}`;
  }

  /**
   * Gets the pod's address. It can be either in the form of
   * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'. See:
   * <a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">Stateful Set documentation</a>
   * for more details.
   * @param pod the Kubernetes pod, containing the information from the k8s client.
   * @returns string the k8s MongoDB stable network address, or undefined.
   */
  private getPodStableNetworkAddressAndPort(pod: V1Pod | undefined): string | undefined {
    if (!this.config.k8sMongoServiceName || !pod || !pod.metadata || !pod.metadata.name || !pod.metadata.namespace)
      return;

    return `${pod.metadata.name}.${this.config.k8sMongoServiceName}.${pod.metadata.namespace}.svc.${this.config.k8sClusterDomain}:${this.config.mongoPort}`;
  }

  public toPodMember(pod: V1Pod | undefined): PodMember {
    if (pod) {
      return {
        pod,
        ip: pod.status?.podIP,
        host: this.getPodAddress(pod),
        isRunning: pod.status?.phase !== 'Running' && pod.status?.podIP ? true : false,
      };
    }
    return {};
  }

  //#endregion
}
