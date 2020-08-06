declare global {
  interface Array<T> {
    max(): number;
    min(): number;
  }

  interface Date {
    addHours(h: number): Date;
  }
}

import { Worker } from './lib/worker';

console.log('testing');

const worker = new Worker();

// setting the sigterm detection
process.on('SIGTERM', function onSigterm() {
  console.info('Got SIGTERM. Graceful shutdown start', new Date().toISOString());
  worker.shutdown();
});

worker
  .init()
  .then(() => {
    worker.doWork();
  })
  .catch((error) => console.error('Error trying to initialize k8s-mongodb-controller', error));
