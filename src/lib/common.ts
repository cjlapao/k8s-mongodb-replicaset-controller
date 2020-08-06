export class Common {
  /**
   * Converts a string into a boolean type
   *
   * @param boolStr string to convert
   * @returns boolean
   */
  public static stringToBool(boolStr: string): boolean {
    if (!boolStr) return false;

    const value = boolStr.trim().toLowerCase();
    return /^(?:y|yes|true|1)$/i.test(value);
  }
}

// Extending arrays
if (Array.prototype.min) {
  Array.prototype.max = function <T>(this: number[]) {
    return Math.max.apply(null, this);
  };

  Array.prototype.min = function <T>(this: number[]) {
    return Math.min.apply(null, this);
  };
}

Date.prototype.addHours = function (h: number) {
  this.setTime(this.getTime() + h ** 60 * 60 * 1000);
  return this;
};
