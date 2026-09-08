import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { TradeNotFoundError, TradeNotDraftError } from '../trades/store.ts';
import { DeckNotFoundError } from '../decks/store.ts';
import { LocationInUseError } from '../collection/store.ts';
import { ListNameTakenError } from '../collection/wants.ts';
import { InvalidBackupError } from '../porting/backup.ts';
import { CacheLimitError } from '../images/downloadManager.ts';
import { ScryfallError } from '../sync/scryfall.ts';

/**
 * The last line between a thrown error and the client.
 *
 * Routes still handle the errors they have something extra to say about — the
 * location that is still in use reports its card count, the cache limit reports
 * its estimate. This catches everything that gets past them: a known class
 * becomes the 4xx it has always been, and anything else becomes a bare 500.
 *
 * A stack trace never reaches the client. It goes to the log, which is the only
 * place it is any use.
 */

/** Errors whose message is safe to hand back, and the status that fits them. */
function knownStatus(error: FastifyError): number | undefined {
  // Schema validation: the body or params never matched, so no store method ran.
  if (error.validation) return 400;

  if (error instanceof TradeNotFoundError) return 404;
  if (error instanceof DeckNotFoundError) return 404;
  if (error instanceof TradeNotDraftError) return 409;
  if (error instanceof ListNameTakenError) return 409;
  if (error instanceof LocationInUseError) return 409;
  if (error instanceof InvalidBackupError) return 400;
  if (error instanceof CacheLimitError) return 413;
  // Scryfall is upstream of us; its failure is not the client's fault.
  if (error instanceof ScryfallError) return 502;

  // Fastify's own client errors — malformed JSON, unsupported content type.
  // Only 4xx: a statusCode of 500 carries no message worth forwarding.
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return error.statusCode;
  }
  return undefined;
}

/** "body/quantity must be number" — which field, and what was wrong with it. */
function validationMessage(error: FastifyError): string {
  const first = error.validation?.[0];
  if (!first) return 'Invalid request.';
  const where = `${error.validationContext ?? 'request'}${first.instancePath}`;
  return `${where} ${first.message ?? 'is invalid'}`;
}

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const status = knownStatus(error);
  if (status !== undefined) {
    return reply.status(status).send({
      error: error.validation ? validationMessage(error) : error.message,
    });
  }

  request.log.error(
    { err: error, method: request.method, url: request.url },
    'Unhandled error in route',
  );
  return reply.status(500).send({ error: 'Internal error' });
}
