/** An error that carries its own HTTP status — the Nest HttpException shape the
 *  frontend already parses: `{ statusCode, message }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const unauthorized = (m = "Access token is required") => new HttpError(401, m);
export const forbidden = (m = "Forbidden") => new HttpError(403, m);
export const badRequest = (m = "Bad request") => new HttpError(400, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
