import {
  ApolloServer,
  BaseContext,
  ContextFunction,
  HTTPGraphQLRequest,
  HeaderMap,
} from '@apollo/server';
import {
  type HttpHandler,
  type HttpRequest,
  type InvocationContext,
} from '@azure/functions';
import { TextEncoder } from 'node:util';

export type WithRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Represents the arguments passed to an Azure Functions context function.
 *
 * @property context - The Azure Functions invocation context, providing information about the current execution.
 * @property req - The HTTP request object, excluding properties related to body parsing and content retrieval.
 * @property body - The parsed body of the HTTP request, if available.
 */
export interface AzureFunctionsContextFunctionArgument {
  context: InvocationContext;
  req: Omit<
    HttpRequest,
    'body' | 'arrayBuffer' | 'blob' | 'formData' | 'json' | 'text'
  >;
  body: unknown;
}

/**
 * Options for configuring Azure Functions middleware integration.
 *
 * @typeParam TContext - The shape of the context object to be used within the middleware.
 *
 * @property context - An optional function to generate the GraphQL context for each Azure Function invocation.
 *   Receives an argument of type `AzureFunctionsContextFunctionArgument` and returns a context of type `TContext`.
 */
export interface AzureFunctionsMiddlewareOptions<TContext extends BaseContext> {
  context?: ContextFunction<[AzureFunctionsContextFunctionArgument], TContext>;
}

const defaultContext: ContextFunction<
  [AzureFunctionsContextFunctionArgument],
  any
> = async () => ({});

/**
 * Transforms an async iterable of strings into an async iterable of Uint8Array.
 * This is useful for creating a `BodyInit` for a `fetch` request from a string stream.
 *
 */
async function* toUint8ArrayStream(
  source: AsyncIterable<string>,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const chunk of source) {
    yield encoder.encode(chunk);
  }
}

/**
 * Starts the Apollo Server and creates an Azure Functions HTTP handler.
 *
 * @param server - An instance of ApolloServer configured with the desired context.
 * @param options - Optional middleware options for Azure Functions integration.
 */
export function startServerAndCreateHandler(
  server: ApolloServer<BaseContext>,
  options?: AzureFunctionsMiddlewareOptions<BaseContext>,
): HttpHandler;
export function startServerAndCreateHandler<TContext extends BaseContext>(
  server: ApolloServer<TContext>,
  options: WithRequired<AzureFunctionsMiddlewareOptions<TContext>, 'context'>,
): HttpHandler;
export function startServerAndCreateHandler<TContext extends BaseContext>(
  server: ApolloServer<TContext>,
  options?: AzureFunctionsMiddlewareOptions<TContext>,
): HttpHandler {
  server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();
  return async (req: HttpRequest, context: InvocationContext) => {
    const contextFunction = options?.context ?? defaultContext;
    try {
      const normalizedRequest = await normalizeRequest(req);

      const { body, headers, status } = await server.executeHTTPGraphQLRequest({
        httpGraphQLRequest: normalizedRequest,
        context: () =>
          contextFunction({ context, req, body: normalizedRequest.body }),
      });

      if (body.kind === 'chunked') {
        return {
          status: status || 200,
          headers: {
            ...Object.fromEntries(headers),
            'Transfer-Encoding': 'chunked',
          },
          body: toUint8ArrayStream(body.asyncIterator),
        };
      }

      return {
        status: status || 200,
        headers: {
          ...Object.fromEntries(headers),
          'content-length': Buffer.byteLength(body.string).toString(),
        },
        body: body.string,
      };
    } catch (e) {
      context.error('Failure processing GraphQL request', e);
      return {
        status: 400,
        body: (e as Error).message,
      };
    }
  };
}

async function normalizeRequest(req: HttpRequest): Promise<HTTPGraphQLRequest> {
  if (!req.method) {
    throw new Error('No method');
  }

  return {
    method: req.method,
    headers: normalizeHeaders(req),
    search: new URL(req.url).search,
    body: await parseBody(req),
  };
}

async function parseBody(req: HttpRequest): Promise<unknown> {
  const isValidContentType = req.headers
    .get('content-type')
    ?.startsWith('application/json');
  const isValidPostRequest = req.method === 'POST' && isValidContentType;

  if (isValidPostRequest) {
    return req.json();
  }

  return null;
}

function normalizeHeaders(req: HttpRequest): HeaderMap {
  const headerMap = new HeaderMap();

  for (const [key, value] of req.headers.entries()) {
    headerMap.set(key, value ?? '');
  }
  return headerMap;
}
