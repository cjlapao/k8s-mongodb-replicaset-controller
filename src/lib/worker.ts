import { Logger } from './services/logger';
import { PodHelper } from './helpers/pods';
import { WorkerStatus } from './worker-status';
import { MongoClient, Db } from 'mongodb';
import { V1PodList } from '@kubernetes/client-node';
import { lookup as _lookup } from 'dns';
import { hostname } from 'os';
import { promisify } from 'util';
import { MongoManager } from './mongo';
import { Config } from './config';
import { K8sClient } from './k8s';
import { PodMember } from './models/PodMember';
import { ReplicaSetStatus, ReplicaSetConfig } from './models/replicaset-config';
import { Common } from './common';
import { ReplicaChanges } from './replica-changes';

export class Worker {
  workerStatus: WorkerStatus;
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
    this.workerStatus = new WorkerStatus();
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
    if (!this.mongoManager.client?.isConnected()) {
      Logger.success('No connection to mongodb, connecting to ');
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
    } catch (err) {
      return this.finishWork(err);
    }

    if (!this.pods?.items) {
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
        if (pod.status?.phase !== 'Running' || !pod.status?.podIP) {
          this.pods.items.splice(i, 1);
        }
      }

      // Pushing changes to the workerStatus Pods
      this.pods.items.forEach((pod) => {
        this.workerStatus.availablePods.push(this.podHelper.toPodMember(pod));
        this.workerStatus.pods.push(this.podHelper.toPodMember(pod));
      });

      Logger.information('Available Pods:');
      this.workerStatus.pods.forEach((pod) => {
        Logger.information(`  - Pod: ${pod.host} -> ${pod.ip}`);
      });

      if (!this.workerStatus.availablePods.length) {
        return this.finishWork('No pods are currently running, probably just give them some time.', true);
      }
    } catch (error) {
      Logger.error(`There was an error processing live pods, we will try again in ${this.loopSleepSeconds}s`, error);
      this.finishWork(error);
    }

    // We have the pods, lets query mongo to get the replica set status
    try {
      const lastUpdate = new Date(this.workerStatus.replicaSetStatusLastUpdate).addHours(1);
      if (this.workerStatus.replicaSetStatusLastUpdate < 0 || lastUpdate.getTime() < now.getTime()) {
        Logger.information(`ReplicaSet Status is too old, we will update it`);
        let replicaSetStatus: ReplicaSetStatus | undefined;
        try {
          replicaSetStatus = await this.mongoManager.getReplicaSetStatus();
        } catch (error) {
          replicaSetStatus = {
            ok: 0,
            code: -1,
          };
          this.finishWork(error, true);
        }
        if (replicaSetStatus) {
          this.workerStatus.replicaSetStatus = replicaSetStatus;
          this.workerStatus.replicaSetStatusLastUpdate = now.getTime();
          this.workerStatus.set = replicaSetStatus.set;
          this.workerStatus.lastStatusCode = replicaSetStatus.code;
        } else {
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
            Logger.success(
              `ReplicaSet is initiated and healthy, found ${this.workerStatus.replicaSetStatus.members?.length} node in replica members`
            );

            Logger.info(`Mapping MongoDB ReplicaSet Members to Worker Pods:`);
            this.matchReplicaSetStateMembersToPodMembers();

            this.generateReplicaSetInstructions();

            this.applyReplicaSetInstructions();
            break;
          default:
            Logger.warning(
              `Something seems odd as we did not find a use case in the status ${JSON.stringify(
                this.workerStatus.replicaSetStatus
              )}`
            );
            this.finishWork();
            break;
        }
      } else {
        this.finishWork('Could not find a ReplicaSet Status in the system, closing connections until next loop', true);
      }
      Logger.success(`Finished workloop waiting for ${this.config.loopSleepSeconds} seconds...`);
      this.finishWork();
    } catch (err) {
      this.finishWork(err, true);
    }
  }

  public shutdown() {
    if (this.mongoClient) this.mongoClient.close();
    process.exit();
  }

  public finishWork(error?: any, closeConnection?: boolean) {
    this.workerStatus.replicaSetStatusLastUpdate = -1;
    if (error) {
      console.error('Error in workloop:', error);
      if (this.mongoClient) {
        this.workerStatus.replicaSetStatusLastUpdate = -1;
        this.mongoClient.close();
      }
    }

    if (closeConnection && this.mongoClient) this.mongoClient.close();

    setTimeout(() => {
      this.doWork();
    }, this.loopSleepSeconds * 1000);
  }

  public async initiateReplicaSet() {
    const primaryNode = this.podHelper.electMasterPod(this.workerStatus.pods);
    if (primaryNode) {
      Logger.info(`Setting ${primaryNode} has the primary node`);
      const result = await this.mongoManager.initReplicaSet(this.workerStatus.pods);
      Logger.info(`ReplicaSet initiation completed`, result);
    }
  }

  //#region private helpers
  private async mongoClientInit(host?: string) {
    if (this.config.debug) {
      this.mongoClient = await this.mongoManager.init('127.0.0.1');
    } else {
      host = host ? host : this.config.k8sMongoServiceName;
      this.mongoClient = await this.mongoManager.init(host);
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

  private matchReplicaSetStateMembersToPodMembers() {
    if (this.workerStatus.replicaSetStatus && this.workerStatus.replicaSetStatus.members) {
      let containsPrimary = false;
      this.workerStatus.replicaSetStatus.members.forEach((member) => {
        const memberHost = member.name.toLowerCase();
        const existingMember = this.workerStatus.pods.find((f) => (f.host ?? '').toLowerCase() === memberHost);
        if (existingMember) {
          Logger.information(
            `Mongo ReplicaSet Member ${member.name} was matched with ${existingMember.host} in the available pods: [ip] ${existingMember.ip}`
          );
          existingMember.mongoNode = member;
          existingMember.change = 'UNCHANGED';
          existingMember.id = member._id;
          existingMember.votes = 1;
          existingMember.priority = 1;
          existingMember.isPrimary = Common.isPrimary(member.stateStr);
          if (existingMember.isPrimary) {
            if (containsPrimary) {
              existingMember.priority = 1;
              Logger.warning(
                `there was already a pod that was set to primary, setting this one with a lower priority for election`,
                existingMember
              );
            } else existingMember.priority = 10;
            containsPrimary = true;
          }
        } else {
          Logger.information(
            `Mongo ReplicaSet Member ${member.name} was not matched with any pods, setting flag for removal`
          );
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
    }
  }

  private generateReplicaSetInstructions() {
    this.workerStatus.changes = new ReplicaChanges();
    if (this.workerStatus.pods && this.workerStatus.pods.length > 0) {
      const primaryPod = this.workerStatus.pods.find((f) => f.isPrimary);
      let electingNewPrimary = false;
      if (primaryPod?.mongoNode && primaryPod.isPrimary && primaryPod.change === 'REMOVE') {
        Logger.blue(
          `Primary member ${primaryPod.host} is stepping down due to be removed, electing new primary member`
        );
        this.workerStatus.changes.isPrimarySteppingDown = true;
        this.workerStatus.changes.masterSteppingDown = primaryPod;
        this.workerStatus.changes.masterSteppingUp = this.getOlderPod(this.workerStatus.pods);
        if (this.workerStatus.changes.masterSteppingUp.change === 'UNCHANGED') {
          this.workerStatus.changes.masterSteppingUp.change = 'ADD';
        }
        this.workerStatus.changes.masterSteppingUp.priority = 10;
        electingNewPrimary = true;
        Logger.success(
          `Primary member ${this.workerStatus.changes.masterSteppingUp.host} is stepping up, congratulations`
        );
      }

      if (electingNewPrimary) {
        this.workerStatus.changes.changes.push({
          _id: this.workerStatus.changes.masterSteppingUp?.id ?? -1,
          action: 'ADD',
          host: this.workerStatus.changes.masterSteppingUp?.host ?? '',
          isMaster: true,
          priority: 10,
          votes: 1,
          isSteppingDown: false,
        });
        this.workerStatus.changes.changes.push({
          _id: this.workerStatus.changes.masterSteppingDown?.id ?? -1,
          action: 'REMOVE',
          host: this.workerStatus.changes.masterSteppingDown?.host ?? '',
          isMaster: true,
          priority: 0,
          votes: 0,
          isSteppingDown: true,
        });
        this.workerStatus.pods.forEach((pod) => {
          if (
            pod.host !== this.workerStatus.changes.masterSteppingUp?.host &&
            pod.host !== this.workerStatus.changes.masterSteppingDown?.host &&
            pod.change !== 'UNCHANGED'
          ) {
            this.workerStatus.changes.changes.push({
              _id: -1,
              action: pod.change === 'ADD' ? 'ADD' : 'REMOVE',
              host: pod.host ?? '',
              isMaster: false,
              priority: 1,
              votes: 1,
              isSteppingDown: false,
            });
          }
        });
      } else {
        this.workerStatus.pods.forEach((pod) => {
          if (pod.change !== 'UNCHANGED') {
            this.workerStatus.changes.changes.push({
              _id: -1,
              action: pod.change === 'ADD' ? 'ADD' : 'REMOVE',
              host: pod.host ?? '',
              isMaster: false,
              priority: 1,
              votes: 1,
              isSteppingDown: false,
            });
          }
        });
      }

      Logger.success(`Finished building the ReplicaSet changes:`, this.workerStatus.changes);
    }
  }

  private async applyReplicaSetInstructions() {
    try {
      if (this.workerStatus.changes.hasChanges) {
        let rsConfig: ReplicaSetConfig | undefined;
        Logger.info('Changes detected, applying...');
        Logger.info('Getting ReplicaSet current config');
        rsConfig = await this.mongoManager.getReplicaSetConfig();
        if (rsConfig) {
          let max = Math.max.apply(
            null,
            rsConfig.members.map((m) => m._id)
          );
          Logger.info(`ReplicaSet config was successfully retrieved, it contains ${rsConfig.members.length} members`);
          if (this.workerStatus.changes.isPrimarySteppingDown) {
            Logger.info('Primary node is stepping down, electing new primary');
            if (this.workerStatus.changes.changes[0]._id === -1) {
              this.workerStatus.changes.changes[0]._id = ++max;
            }

            rsConfig.members.push({
              _id: this.workerStatus.changes.changes[0]._id,
              host: this.workerStatus.changes.changes[0].host,
              priority: this.workerStatus.changes.changes[0].priority,
              votes: this.workerStatus.changes.changes[0].votes,
            });
            Logger.info('Reconfiguring ReplicaSet to add new Primary Node');
            rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
            Logger.success(`Added new primary: ${this.workerStatus.changes.changes[0].host}`);
            if (rsConfig) {
              Logger.info('Removing old primary and waiting 20s for election');
              setTimeout(async () => {
                const oldMasterIndex = rsConfig?.members.findIndex(
                  (f) => f.host === this.workerStatus.changes.changes[1].host
                );
                if (oldMasterIndex && oldMasterIndex > -1) {
                  rsConfig?.members.splice(oldMasterIndex, 1);
                }
                Logger.info('Closing current connection as primary node changed');
                await this.mongoManager.client?.close();
                await this.mongoClientInit();
                Logger.info('Getting the latest primary from the configuration');
                Logger.info(
                  `Connecting to ${this.workerStatus.changes.changes[0].host} as this should be the master now`
                );
                await this.mongoClientInit();
                if (this.mongoManager.client?.isConnected) {
                  Logger.info(
                    'Reconfiguring ReplicaSet to remove old Primary Node and waiting 20 seconds for the update'
                  );
                  rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                  Logger.success(`Removed old primary: ${this.workerStatus.changes.changes[1].host}`);
                  setTimeout(() => {
                    if (rsConfig) {
                      let i = Math.max.apply(
                        null,
                        rsConfig.members.map((m) => m.priority ?? 0)
                      );
                      Logger.info('Applying the rest of the changes');
                      this.workerStatus.changes.changes.forEach(async (pod) => {
                        if (
                          pod.host !== this.workerStatus.changes.changes[0].host &&
                          pod.host !== this.workerStatus.changes.changes[1].host
                        ) {
                          if (rsConfig) {
                            if (pod.action === 'ADD') {
                              rsConfig.members.push({
                                _id: ++max,
                                host: pod.host,
                                priority: i,
                                votes: 1,
                              });
                              rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                              Logger.success(`Added member ${pod.host}`);
                            }
                            i++;
                            if (pod.action === 'REMOVE') {
                              if (rsConfig) {
                                const podToRemoveIndex = rsConfig.members.findIndex((f) => f.host === pod.host);
                                if (podToRemoveIndex > -1) {
                                  rsConfig.members.splice(podToRemoveIndex, 1);
                                  rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                                  Logger.success(`Removed member ${pod.host}`);
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
          } else {
            if (rsConfig) {
              let i = Math.max.apply(
                null,
                rsConfig.members.map((m) => m.priority ?? 0)
              );
              Logger.info('Applying changes, no primary node will be changed');
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
                    Logger.success(`Added member ${pod.host}`);
                  }
                  i++;
                  if (pod.action === 'REMOVE') {
                    if (rsConfig) {
                      const podToRemoveIndex = rsConfig.members.findIndex((f) => f.host === pod.host);
                      if (podToRemoveIndex > -1) {
                        rsConfig.members.splice(podToRemoveIndex, 1);
                        rsConfig = await this.mongoManager.reconfigReplicaSet(rsConfig);
                        Logger.success(`Removed member ${pod.host}`);
                      }
                    }
                  }
                  i++;
                }
              });
            }
          }
        } else {
          this.finishWork('Could not find a valid ReplicaSet Config', true);
        }
      }
    } catch (error) {
      this.finishWork(error, true);
    }
  }

  private getOlderPod(pods: PodMember[]) {
    pods.sort((a, b) => {
      const aDate = a.k8sPod?.metadata?.creationTimestamp;
      const bDate = b.k8sPod?.metadata?.creationTimestamp;
      if (!aDate < !bDate) return -1;
      if (!aDate > !bDate) return 1;
      return 0; // Shouldn't get here... all pods should have different dates
    });
    return pods[0];
  }

  private removePortFromHost(str: string): string {
    let result = str;
    const portStr = `:${this.config.mongoPort}`;
    if (result.includes(portStr)) {
      const indexOf = result.indexOf(portStr);
      result = result.substring(0, indexOf);
    }

    return result;
  }
  //#endregion
}
