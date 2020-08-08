import {
  ReplicaSetConfig,
  ReplicaSetMember,
  CertificatesStore,
  ReplicaSetStatus,
  ReplicaSetStateMember,
} from './models/replicaset-config';
import { Config } from './config';
import { promisify } from 'util';
import { MongoClient, MongoClientOptions, Db } from 'mongodb';
import { readFile } from 'fs';
import { PodMember } from './models/PodMember';
import { Logger } from './services/logger';

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
        .command({ replSetGetConfig: 1 }, { readPreference: 'primary' })
        .then((results) => {
          return results.config as ReplicaSetConfig;
        });
    }
  }

  public async getReplicaSetStatus() {
    let status: ReplicaSetStatus;
    if (this.db) {
      try {
        console.log('Checking replicaSet status');
        const result = await this.db.admin().command({ replSetGetStatus: {} }, { readPreference: 'primary' });
        status = {
          set: result.set,
          ok: result.ok,
          code: 0,
          members: result.members ? (result.members as ReplicaSetStateMember[]) : [],
        };
        return status;
      } catch (error) {
        if (error.code && error.code === 94) {
          status = {
            ok: 0,
            code: error.code,
          };
        } else {
          Logger.error(`There was an error collecting the ReplicaSetStatus`, error);
          status = {
            ok: -1,
            code: error.code,
          };
        }

        if (error.MongoError) {
          await this.init(this.config.k8sMongoServiceName);
        }
        return status;
      }
    }
  }

  public async initReplicaSet(pods: PodMember[]) {
    if (this.db) {
      if (!pods || pods.length === 0) {
        throw new Error(`there is no pods to initiate`);
      }

      try {
        // building the initiate command
        const members: any[] = [];
        let i = 0;
        pods.forEach((pod) => {
          Logger.info(`Adding ${pod.host} to the initial ReplicaSet`);
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

        return await this.getReplicaSetConfig();
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }

  public async reconfigReplicaSet(replSetConfig: ReplicaSetConfig | undefined, force?: boolean) {
    if (this.db) {
      try {
        const times = 20;
        const interval = 500;
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

        let tries = 0;
        while (tries < times) {
          try {
            if (!force) force = false;
            else force = true;
            if (replSetConfig) {
              replSetConfig.version++;
              await this.db.admin().command({ replSetReconfig: replSetConfig, force }, { readPreference: 'primary' });
              replSetConfig = await this.getReplicaSetConfig();
              return replSetConfig;
            }
          } catch (error) {
            Logger.error('error 0', error);
            if (error.MongoError) {
              await this.client?.close();
              this.client = await this.init(this.config.k8sMongoServiceName);
            }
            await wait(interval);
            tries++;
            if (tries >= times) return Promise.reject(error);
          }
        }
      } catch (error) {
        Logger.error('error 1', error);
        return Promise.reject(error);
      }
    }
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
