import {
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import lodash from 'lodash';

import { AppBootstrapperModule } from './app-bootstrapper.module';
import {
  type IAppBootstrapperExtension,
  type IAppBootstrapperParams,
} from './app-bootstrapper.types';
import {
  type BaseLogger,
  type ILoggerParams,
  LoggerModule,
} from './logger/index';

export class AppBootstrapper {
  private bootstrapModules: NonNullable<ModuleMetadata['imports']> = [];
  private defaultLogger?: Type<BaseLogger>;
  private loggerParams: ILoggerParams;
  private extensions: IAppBootstrapperExtension[] = [];

  constructor(private readonly params: IAppBootstrapperParams) {
    this.loggerParams = {
      environment: this.params.environment,
      appName: this.params.appName,
      appVersion: this.params.appVersion,
    };
  }

  public addModules(modules: NonNullable<ModuleMetadata['imports']>) {
    this.bootstrapModules.push(...modules);
  }

  public setupLogger(
    params: Omit<ILoggerParams, 'environment' | 'appName' | 'appVersion'>,
    logger?: Type<BaseLogger>,
  ) {
    this.loggerParams = {
      ...this.loggerParams,
      ...params,
    };

    if (logger) {
      this.defaultLogger = logger;
    }
  }

  public addExtension(extension: IAppBootstrapperExtension) {
    this.extensions.push(extension);
  }

  private buildLoggerModule() {
    const defaultExtensionLogger = this.extensions.find(
      (e) => e.defaultLogger,
    )?.defaultLogger;

    return LoggerModule.forRoot(
      {
        ...this.loggerParams,
        environment: this.params.environment,
        appName: this.params.appName,
        appVersion: this.params.appVersion,
      },
      this.defaultLogger ?? defaultExtensionLogger,
    );
  }

  /**
   * Returns module configuration for testing purposes.
   * This includes all modules from extensions and the bootstrap modules.
   * Use this with NestJS Testing utilities to create a test module.
   */

  public buildModule(modules?: NonNullable<ModuleMetadata['imports']>) {
    return AppBootstrapperModule.forRoot(
      lodash.compact([
        ...this.bootstrapModules,
        this.buildLoggerModule(),
        ...lodash.flatten(this.extensions.map((e) => e.modules)),
        ...(modules || []),
      ]),
      this.params,
    );
  }

  public async init(module?: DynamicModule) {
    const appBootstrapperModule = module || this.buildModule();

    const customBootstrapperList = lodash.compact(
      this.extensions.map((e) => e.customBootstrapper),
    );

    if (customBootstrapperList.length > 0) {
      for (const customBootstrapper of customBootstrapperList) {
        await customBootstrapper(appBootstrapperModule);
      }
    } else {
      const app = await NestFactory.createApplicationContext(
        appBootstrapperModule,
      );

      await app.init();
      await app.close();
    }
  }
}
