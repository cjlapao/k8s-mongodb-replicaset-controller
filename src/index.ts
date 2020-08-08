import { Worker } from './lib/worker';

declare global {
  interface Array<T> {
    max(): number;
    min(): number;
  }

  interface Date {
    addHours(h: number): Date;
  }
}

// Extensions
if (Array.prototype.min) {
  Array.prototype.max = function <T>(this: number[]) {
    return Math.max.apply(null, this);
  };

  Array.prototype.min = function <T>(this: number[]) {
    return Math.min.apply(null, this);
  };
}

Date.prototype.addHours = function (h: number) {
  console.log('getting new data');
  const hourToStamp = h * 60 * 60 * 1000;
  const newTime = this.setTime(this.getTime() + hourToStamp);
  return new Date(newTime);
};

// setting the sigterm detection
process.on('SIGTERM', function onSigterm() {
  console.info('Got SIGTERM. Graceful shutdown start', new Date().toISOString());
  worker.shutdown();
});

console.log('testing');

const worker = new Worker();

worker
  .init()
  .then(() => {
    worker.doWork();
  })
  .catch((error) => console.error('Error trying to initialize k8s-mongodb-controller', error));
