// Typed errors the HTTP layer maps to status codes.

export class NotFound extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

export class BadRequest extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

export class Unauthorized extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "Unauthorized";
  }
}
