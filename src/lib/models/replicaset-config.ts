export interface ReplicaSetConfig {
  _id: string;
  version: number;
  protocolVersion?: number;
  configsvr?: boolean;
  writeConcernMajorityJournalDefault?: boolean;
  members: ReplicaSetMember[];
  settings: ReplicaSetSettings;
}

export interface ReplicaSetMember {
  _id: number;
  host: string;
  arbiterOnly?: boolean;
  buildIndexes?: boolean;
  hidden?: boolean;
  priority?: number;
  slaveDelay?: number;
  votes?: number;
}

export interface ReplicaSetSettings {
  chainingAllowed?: boolean;
  heartbeatIntervalMillis?: number;
  heartbeatTimeoutSecs?: number;
  electionTimeoutMillis?: number;
  catchUpTimeoutMillis?: number;
  getLastErrorDefaults?: GetLastErrorDefaults;
  replicaSetId?: string;
}

export interface GetLastErrorDefaults {
  w?: number;
  wtimeout?: number;
}

export interface CertificatesStore {
  sslCert: Buffer | undefined;
  sslKey: Buffer | undefined;
  sslCA: Buffer | undefined;
  sslCRL: Buffer | undefined;
}

export interface ReplicaSetStatus {
  set?: string;
  ok?: number;
  code?: number;
  members?: [];
}
