# @packages/metrics

Note: For repository-wide testing and code guidelines, see `.guidelines/testing.md` and `.guidelines/code-guidelines.md`.


This library provides a NestJS module for integrating with Prometheus metrics. It offers a service to initialize, configure, and manage different types of metrics for monitoring your application.

## Installation

```bash
pnpm add @packages/metrics
```

## Core Features

- **Prometheus Integration**: Seamless integration with Prometheus metrics
- **Multiple Metric Types**: Support for Counter, Gauge, and Histogram metrics
- **Global Module**: Available throughout your application
- **Pushgateway Support**: Push metrics to a Prometheus Pushgateway
- **Type-Safe API**: Fully typed API for working with metrics

## Usage Guide

### Basic Setup

There are two ways to use the metrics package:

#### 1. As a standalone module

Import the MetricsModule in your application:

```typescript
import { Module } from '@nestjs/common';
import { MetricsModule } from '@packages/metrics';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    MetricsModule.forRoot(),
    // Other modules...
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

#### 2. As an extension for AppBootstrapper

Use the buildMetricExtension function to add metrics functionality to your application:

```typescript
import { buildBootstrapper } from '@packages/common';
import { buildMetricExtension } from '@packages/metrics';
import { AppModule } from './app.module';
import { environment } from './environments';

// Create a bootstrapper instance
const bootstrapper = buildBootstrapper({
  environment: environment.env,
  appName: environment.appName,
  appVersion: environment.appVersion,
});

// Add your application modules
bootstrapper.addModules([AppModule]);

// Add metrics extension
bootstrapper.addExtension(
  buildMetricExtension((metricsService) => {
    // Optional: Register custom metrics
    metricsService.registerCounter(
      'custom_counter',
      'A custom counter metric',
      ['label1', 'label2']
    );
  })
);

// Initialize the application
bootstrapper.init().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
```

### Using Metrics in a Service

Inject the MetricsService into your service and use it to register and update metrics:

```typescript
import { Injectable } from '@nestjs/common';
import { MetricsService } from '@packages/metrics';

@Injectable()
export class UserService {
  private readonly USER_COUNTER = 'user_operations_total';
  private readonly REQUEST_DURATION = 'request_duration_seconds';

  constructor(private readonly metricsService: MetricsService) {
    // Register a counter metric
    this.metricsService.registerCounter(
      this.USER_COUNTER,
      'Total number of user operations',
      ['operation', 'status']
    );

    // Register a histogram metric for request duration
    this.metricsService.registerHistogram(
      this.REQUEST_DURATION,
      'Request duration in seconds',
      ['endpoint'],
      [0.1, 0.5, 1, 2, 5]
    );
  }

  async createUser(userData: any) {
    const startTime = process.hrtime();

    try {
      // Your user creation logic here

      // Increment the counter for successful operations
      this.metricsService.incCounter(this.USER_COUNTER, 1, {
        operation: 'create',
        status: 'success'
      });

      return { success: true };
    } catch (error) {
      // Increment the counter for failed operations
      this.metricsService.incCounter(this.USER_COUNTER, 1, {
        operation: 'create',
        status: 'error'
      });

      throw error;
    } finally {
      // Record the request duration
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const duration = seconds + nanoseconds / 1e9;

      this.metricsService.observeHistogram(this.REQUEST_DURATION, duration, {
        endpoint: '/users'
      });
    }
  }
}
```

### Automatic Metrics Collection

The metrics package automatically applies the `FastifyMetricsMiddleware` to all routes in your application. This middleware:

1. Counts incoming HTTP requests using the `RequestMetric` gauge
2. Measures request duration using the `RequestTimeMetric` histogram
3. Ignores certain paths like health checks, Swagger API, and metrics endpoints

You don't need to manually configure this middleware - it's applied automatically when you import the MetricsModule.

### Exposing Metrics Endpoint

The metrics package automatically provides a `/metrics` endpoint that returns all registered metrics in Prometheus format. You don't need to create a controller for this - it's included in the MetricsModule.

If you need to create a custom metrics endpoint:

```typescript
import { Controller, Get } from '@nestjs/common';
import { MetricsService } from '@packages/metrics';

@Controller('custom-metrics')
export class CustomMetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async getMetrics() {
    return this.metricsService.getAll();
  }
}
```

### Pushing Metrics to Pushgateway

If you need to push metrics to a Prometheus Pushgateway:

```typescript
import { Injectable } from '@nestjs/common';
import { MetricsService } from '@packages/metrics';

@Injectable()
export class MetricsPusherService {
  constructor(private readonly metricsService: MetricsService) {}

  async pushMetrics() {
    await this.metricsService.pushMetrics(
      'http://pushgateway:9091',
      'my-application'
    );
  }
}
```

## API Reference

### MetricsModule

```typescript
class MetricsModule {
  static forRoot(init?: (svc: MetricsService) => void): DynamicModule;
}
```

### buildMetricExtension

```typescript
function buildMetricExtension(
  init?: (svc: MetricsService) => void
): IAppBootstrapperExtension;
```

This function creates an extension for the AppBootstrapper from the common package. The optional `init` callback allows you to register custom metrics when the module is initialized.

### MetricsService

```typescript
class MetricsService {
  // Get all metrics as a string
  getAll(): Promise<string>;

  // Clear all registered metrics
  clearAll(): Promise<void>;

  // Get metrics by name
  getGauge(index: string): Gauge | undefined;
  getCounter(index: string): Counter | undefined;
  getHistogram(index: string): Histogram | undefined;

  // Register metrics
  registerGauge(index: string, description: string, labels: string[]): void;
  registerCounter(index: string, description: string, labels: string[]): void;
  registerHistogram(
    index: string,
    description: string,
    labels: string[],
    buckets?: number[]
  ): void;

  // Update metrics
  incCounter(index: string, val: number, labels?: Labels): void;
  setGauge(index: string, val: number, labels?: Labels): void;
  incGauge(index: string, val: number, labels?: Labels): void;
  observeHistogram(index: string, val: number, labels?: Labels): void;

  // Push metrics to Pushgateway
  pushMetrics(gatewayUrl: string, jobName: string): Promise<void>;
}
```

### Labels Type

```typescript
type Labels = {
  [key: string]: string;
};
```

## Default Metrics

The MetricsModule automatically registers the following metrics:

### RequestMetric ('ingress_requests')

A gauge metric that counts incoming HTTP requests with labels for path, method, and status.

### RequestTimeMetric ('ingress_request_duration_seconds')

A histogram metric that measures the duration of incoming HTTP requests with labels for path and method.

### InstanceMetric ('app_instance')

A gauge metric that provides information about the application instance with labels for version, pid, and app name.

## Metric Types

### Counter

A cumulative metric that represents a single monotonically increasing counter whose value can only increase or be reset to zero.

Use cases:
- Number of requests processed
- Number of errors
- Number of tasks completed

### Gauge

A metric that represents a single numerical value that can arbitrarily go up and down.

Use cases:
- Memory usage
- CPU usage
- Number of active connections
- Queue size

### Histogram

A metric that samples observations and counts them in configurable buckets.

Use cases:
- Request duration
- Response size
- Queue processing time
