import { V1Pod } from '@kubernetes/client-node';

export interface PodMember {
  pod?: V1Pod;
  host?: string;
  ip?: string;
  isRunning?: boolean;
  isPrimary?: boolean;
  priority?: number;
  change?: 'ADD' | 'REMOVE' | 'NONE';
}
