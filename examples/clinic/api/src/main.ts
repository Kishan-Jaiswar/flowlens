import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import { AppModule } from './app.module';

/**
 * How you wire FlowLens runtime tracing into a NestJS app.
 *
 * Two lines, both guarded by NODE_ENV, and both entirely optional: the static
 * analyzer works with no instrumentation at all. Tracing only adds the second
 * half of the picture — proof that a path actually executed, and how long each
 * step took.
 *
 * Nothing here is FlowLens connecting to your database. `flowlensMongoose` is a
 * Mongoose plugin that times the queries *your* app already makes and appends
 * them to a local file (.flowlens/trace.jsonl). If you never register it, the
 * tracer records nothing.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  if (process.env.NODE_ENV !== 'production') {
    const { flowlensHttp, flowlensMongoose } = await import('@flowlens/runtime');

    // 1. One span per HTTP request, and the trace context every child span joins.
    app.use(flowlensHttp());

    // 2. One span per database operation, timed by Mongoose's own hooks.
    mongoose.plugin(flowlensMongoose({ ignoreCollections: ['sessions'] }));
  }

  await app.listen(3001);
}

void bootstrap();
