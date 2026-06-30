# @packages/common

Note: For repository-wide testing and code guidelines, see `.guidelines/testing.md` and `.guidelines/code-guidelines.md`.


This library provides a Nest module that integrates `ConfigModule`, `Logger`, and additional modules to help bootstrap your application efficiently.

## Installation

```bash
pnpm add @packages/common
```

## Core Features

### App Bootstrapper

The App Bootstrapper is a powerful utility for initializing your NestJS application with standardized configuration.

#### Key Components:

- **AppBootstrapper**: Main class for bootstrapping your application
- **AppBootstrapperModule**: NestJS module that integrates with your application
- **AppBootstrapperConfigService**: Service for accessing bootstrap configuration

### Configurable Logger

A flexible logging system with:
- Multiple log levels (debug, info, warn, error, system)
- Pretty printing for development
- Sentry integration for error tracking
- Request context awareness

### Exception Handling

Standardized exception handling with:
- Base exception classes for different error types
- Error code management
- Integration with Sentry

### Environment Utilities

Utilities for working with environment variables and configuration.

## Usage Guide

### Basic Application Bootstrap

```typescript
import { buildBootstrapper } from '@packages/common';
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

// Configure logger
bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel,
  sentryDsn: environment.sentryDsn,
});

// Initialize the application
bootstrapper.init().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
```

### HTTP Server Integration

To enable HTTP server functionality:

```typescript
import { buildBootstrapper } from '@packages/common';
import { buildHttpServerExtension } from '@packages/http-server';
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

// Configure logger
bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel,
  sentryDsn: environment.sentryDsn,
});

// Add HTTP server extension
bootstrapper.addExtension(
  buildHttpServerExtension({
    globalPrefix: environment.globalPrefix,
    swaggerPath: environment.swaggerPath,
    apiDefaultVersion: '1',
    port: environment.port,
  })
);

// Initialize the application
bootstrapper.init().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
```

### Metrics Integration

To enable metrics functionality:

```typescript
import { buildBootstrapper } from '@packages/common';
import { buildHttpServerExtension } from '@packages/http-server';
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

// Configure logger
bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel,
  sentryDsn: environment.sentryDsn,
});

// Add HTTP server extension
bootstrapper.addExtension(
  buildHttpServerExtension({
    globalPrefix: environment.globalPrefix,
    swaggerPath: environment.swaggerPath,
    apiDefaultVersion: '1',
    port: environment.port,
  })
);

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

## API Reference

### AppBootstrapper

```typescript
class AppBootstrapper {
  constructor(params: IAppBootstrapperParams);

  // Add NestJS modules to the application
  addModules(modules: NonNullable<ModuleMetadata['imports']>): void;

  // Configure the logger
  setupLogger(
    params: Omit<ILoggerParams, 'environment' | 'appName' | 'appVersion'>,
    logger?: Type<BaseLogger>
  ): void;

  // Add an extension to the bootstrapper
  addExtension(extension: IAppBootstrapperExtension): void;

  // Initialize the application
  init(): Promise<void>;
}
```

### IAppBootstrapperParams

```typescript
interface IAppBootstrapperParams {
  environment: string;  // Environment name (e.g., 'development', 'production')
  appName: string;      // Application name
  appVersion: string;   // Application version
}
```

### ILoggerParams

```typescript
interface ILoggerParams {
  prettyPrint?: boolean;  // Enable pretty printing for logs
  sentryDsn?: string;     // Sentry DSN for error tracking
  level?: LogLevel;       // Log level (debug, info, warn, error, system)
  environment: string;    // Environment name
  appName: string;        // Application name
  appVersion: string;     // Application version
}
```

### IAppBootstrapperExtension

```typescript
interface IAppBootstrapperExtension {
  modules: NonNullable<ModuleMetadata['imports']>;  // Modules to add to the application
  defaultLogger?: Type<BaseLogger>;                 // Custom logger implementation
  customBootstrapper?: (module: DynamicModule) => Promise<void>;  // Custom bootstrapping logic
}
```

## Configuration Utility: getEnv

The `getEnv` function retrieves environment variables with optional default values and automatic type conversion.

### Parameters

- `env` (string): The name of the environment variable
- `value` (string | boolean, optional): Default value if the environment variable is not set

### Returns

- The value of the environment variable, or the default value if not set
- Automatically converts string values like 'true', 'false', '1', '0' to booleans

### Example

```typescript
import { getEnv } from '@packages/common';

export const environment = {
  env: getEnv('NODE_ENV', 'production'),
  prettyLog: getEnv('PRETTY_LOGS', false),
  booleanVal: getEnv('BOOL_VAL', 'true'), // will convert to boolean
};
```
