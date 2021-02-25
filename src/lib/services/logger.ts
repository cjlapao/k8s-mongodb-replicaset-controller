import colors from 'colors';

export class Logger {
  public static information(message: string, data?: any): void {
    if (data) {
      console.log(colors.white(message), data);
    } else {
      console.log(colors.white(message));
    }
  }

  public static info(message: string, data?: any): void {
    if (data) {
      console.log(colors.white(message), data);
    } else {
      console.log(colors.white(message));
    }
  }

  public static warning(message: string, data?: any): void {
    if (data) {
      console.log(colors.bold.yellow(message), data);
    } else {
      console.log(colors.bold.yellow(message));
    }
  }

  public static blue(message: string, data?: any): void {
    if (data) {
      console.log(colors.bold.blue(message), data);
    } else {
      console.log(colors.bold.blue(message));
    }
  }

  public static success(message: string, data?: any): void {
    if (data) {
      console.log(colors.bold.green(message), data);
    } else {
      console.log(colors.bold.green(message));
    }
  }

  public static error(message: string, data?: any): void {
    if (data) {
      console.log(colors.bold.red(message), data);
    } else {
      console.log(colors.bold.red(message));
    }
  }

  public static debug(message: string, data?: any): void {
    if (data) {
      console.log(colors.magenta(message), data);
    } else {
      console.log(colors.magenta(message));
    }
  }

  public static trace(message: string, data?: any): void {
    if (data) {
      console.log(colors.bold.grey(message), data);
    } else {
      console.log(colors.bold.grey(message));
    }
  }
}
