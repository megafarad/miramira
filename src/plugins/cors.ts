import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../config/env.js';

const DEV_DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:3000'];

export interface CorsPluginOptions {
  env: Env;
}

const corsPluginInner: FastifyPluginAsync<CorsPluginOptions> = async (app, opts) => {
  const fromEnv = opts.env.CORS_ALLOWED_ORIGINS;
  const origins =
    fromEnv.length > 0 ? fromEnv : opts.env.NODE_ENV !== 'production' ? DEV_DEFAULT_ORIGINS : [];

  await app.register(cors, {
    origin: origins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 600,
  });
};

export const corsPlugin = fp(corsPluginInner, { name: 'cors' });
