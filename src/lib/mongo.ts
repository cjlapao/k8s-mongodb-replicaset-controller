import { ReplicaSetConfig } from './models/replicaset-config';
import { Config } from './config';
import { promisify } from 'util';
import { MongoClient, MongoClientOptions, Db } from 'mongodb';
import { readFile, stat } from 'fs';
import { PodMember } from './models/PodMember';

interface CertificatesStore {
  sslCert: Buffer | undefined;
  sslKey: Buffer | undefined;
  sslCA: Buffer | undefined;
  sslCRL: Buffer | undefined;
}

interface ReplicaSetStatus {
  set?: string;
  ok?: number;
  code?: number;
  members?: [];
}

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

  public async getReplicaSetStatus() {
    if (this.db) {
      let status: ReplicaSetStatus;
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

  public async UpdateReplicaSetMembers(toAdd: PodMember[], toRemove: PodMember[], force: boolean) {
    try {
      const rsConfig = await this.getReplicaSetConfig();
      console.log(rsConfig);
    } catch (error) {
      Promise.reject(error);
    }
  }

  private async reconfigReplicaSet(replSetReconfig: ReplicaSetConfig, force: boolean) {
    if (this.db) {
      console.info('replSetReconfig', replSetReconfig);
      replSetReconfig.version++;
      return await this.db.admin().command({ replSetReconfig, force }, {});
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
}
