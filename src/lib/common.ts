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

  public static isPrimary(str: string): boolean {
    return str.toLowerCase() === 'primary';
  }
}
