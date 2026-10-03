export interface RuleViolation {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (number | string)[];
}

export interface InvariantViolation {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (number | string)[];
}
