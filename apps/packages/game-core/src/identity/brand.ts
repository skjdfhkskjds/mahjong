declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export function createStringIdentifier<Name extends string>(name: Name) {
  return (value: string): Brand<string, Name> => {
    if (value.trim().length === 0) {
      throw new TypeError(`${name} must not be empty.`);
    }

    return value as Brand<string, Name>;
  };
}
