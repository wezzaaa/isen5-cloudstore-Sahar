//potential trap: loading Express before initialization can prevent automatic instrumentation from attaching. Initialize the SDK first
import './instrumentation';
import { metrics } from '@opentelemetry/api';
import { prometheusExporter } from './instrumentation';

import express, { Request, Response } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const SERVICE_NAME = 'service-a-auth';
const tracer = trace.getTracer(SERVICE_NAME);
const meter = metrics.getMeter(SERVICE_NAME);

const httpRequests = meter.createCounter('http_requests', {
  description: 'Number of completed HTTP requests',
});

const httpDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'Duration of completed HTTP requests',
  unit: 's',
});

function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
) {
  const spanContext = trace.getActiveSpan()?.spanContext();

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    event,
    trace_id: spanContext?.traceId ?? null,
    span_id: spanContext?.spanId ?? null,
    ...fields,
  }));
}
// Demo credentials for this lab. An unset JWT_SECRET creates a secret for this process only.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const DEMO_USER = { username: 'demo', password: 'DemoPassword123!', user_id: 'USER-1' };

function setUserContext(_req: Request, res: Response, userId: string) {
  //potential trap: manually generated headers looked like traces, but had no recorded spans. we use active SDK context
  trace.getActiveSpan()?.setAttribute('user.id', userId);
  res.locals.user_id = userId;

  // potential trap: the earlier comment requested user context in baggage. but identity belongs in span attributes or log fields so baggage must stay small and free of sensitive information
  const userContext = propagation.setBaggage(
    context.active(),
    propagation.createBaggage({}),
  );

  const headers: Record<string, string> = {};
  propagation.inject(userContext, headers);

  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

app.use((req, res, next) => {
  // Exclude scrapes so monitoring traffic does not affect RED metrics.
  if (req.path === '/metrics') {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  // potential trap: reading the active span only inside "finish" may lose request correlation. Following the course, capture its IDs while the request context is active.
  const requestSpanContext = trace.getActiveSpan()?.spanContext();

  res.once('finish', () => {
    // potential trap: using req.path or req.originalUrl as labels can create unbounded cardinality. Following the course, use the route template, and one fixed label for requests without a matched route.
    const route =
      typeof req.route?.path === 'string'
        ? req.route.path
        : 'unmatched';

    const method = [
      'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
      'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
    ].includes(req.method)
      ? req.method
      : 'OTHER';

    const labels = {
      method,
      route,
      status: String(res.statusCode),
    };

    const durationSeconds =
      Number(process.hrtime.bigint() - started) / 1e9;

    // Never add user IDs, order IDs, tokens or raw URLs as metric labels.
    httpRequests.add(1, labels);
    httpDuration.record(durationSeconds, labels);
    logEvent(
      res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : 'info',
      'http.request.completed',
      {
        method,
        route,
        status: res.statusCode,
        duration_seconds: durationSeconds,
        trace_id: requestSpanContext?.traceId ?? null,
        span_id: requestSpanContext?.spanId ?? null,
        user_id: res.locals.user_id,
        order_id: res.locals.order_id,
        reservation_id: res.locals.reservation_id,
        transaction_id: res.locals.transaction_id,
      },
    );
  });

  next();
});
app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics
 * Unauthenticated Prometheus exposition endpoint for OpenTelemetry metrics.
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  // potential trap: creating another SERVER span would duplicate HTTP instrumentation. this is an INTERNAL business span.
  return tracer.startActiveSpan('auth.login', (span) => {
    try {
      const { username, password } = req.body ?? {};

      if (typeof username !== 'string' || !username.trim()
        || typeof password !== 'string' || !password) {
        span.setAttribute('auth.outcome', 'invalid_request');
        res.status(400).json({
          error: 'Bad Request',
          message: 'username and password are required',
          status_code: 400,
        });
        return;
      }

      if (username !== DEMO_USER.username || password !== DEMO_USER.password) {
        span.setAttribute('auth.outcome', 'rejected');
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid credentials',
          status_code: 401,
        });
        return;
      }

      const token = jwt.sign({ roles: ['customer'] }, JWT_SECRET, {
        algorithm: 'HS256',
        subject: DEMO_USER.user_id,
        expiresIn: 900,
        issuer: 'cloudstore-auth',
        audience: 'cloudstore',
      });

      span.setAttribute('auth.outcome', 'success');
      setUserContext(req, res, DEMO_USER.user_id);

      res.status(200).json({
        token,
        user_id: DEMO_USER.user_id,
        expires_in: 900,
      });
    } catch (error) {
      logEvent('error', 'auth.login.exception', {
        route: '/auth/login',
        error_type: error instanceof Error ? error.name : 'UnknownError',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication failed',
        status_code: 500,
      });
    } finally {
      //potential trap: early returns could leave a span unfinished. Every operation needs a start and an end
      span.end();
    }
  });
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  return tracer.startActiveSpan('auth.verify', (span) => {
    try {
      const token = req.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];

      if (!token) {
        span.setAttribute('auth.outcome', 'missing_token');
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token is required',
          status_code: 401,
        });
        return;
      }

      try {
        const claims = jwt.verify(token, JWT_SECRET, {
          algorithms: ['HS256'],
          issuer: 'cloudstore-auth',
          audience: 'cloudstore',
        });

        if (typeof claims === 'string'
          || typeof claims.sub !== 'string'
          || !claims.sub
          || typeof claims.exp !== 'number') {
          throw new Error('Invalid token claims');
        }

        span.setAttribute('auth.outcome', 'success');
        setUserContext(req, res, claims.sub);

        res.status(200).json({
          valid: true,
          user_id: claims.sub,
          roles: ['customer'],
        });
      } catch (error) {
        //potential trap: the previous catch discarded the exception. we record exception details as span events.
        logEvent('warn', 'auth.verify.rejected', {
          route: '/auth/verify',
          error_type: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setAttribute('auth.outcome', 'rejected');

        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired token',
          status_code: 401,
        });
      }
    } finally {
      span.end();
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logEvent('info', 'service.started', { port: PORT });
});
