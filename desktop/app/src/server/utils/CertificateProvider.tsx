/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {Logger} from '../../fb-interfaces/Logger';
import {internGraphPOSTAPIRequest} from '../../fb-stubs/user';
import ServerController from '../comms/ServerController';
import {promisify} from 'util';
import fs from 'fs-extra';

import {
  openssl,
  isInstalled as opensslInstalled,
} from './openssl-wrapper-with-promises';
import path from 'path';
import tmp, {DirOptions, FileOptions} from 'tmp';
import iosUtil from '../devices/ios/iOSContainerUtility';
import {reportPlatformFailures} from '../../utils/metrics';
import {getAdbClient} from '../devices/android/adbClient';
import * as androidUtil from '../devices/android/androidContainerUtility';
import os from 'os';
import {Client as ADBClient} from 'adbkit';
import archiver from 'archiver';
import {timeout} from 'flipper-plugin';
import {v4 as uuid} from 'uuid';
import {isTest} from '../../utils/isProduction';
import {message} from 'antd';

export type CertificateExchangeMedium = 'FS_ACCESS' | 'WWW' | 'NONE';

const tmpFile = promisify(tmp.file) as (
  options?: FileOptions,
) => Promise<string>;
const tmpDir = promisify(tmp.dir) as (options?: DirOptions) => Promise<string>;

// Desktop file paths
const caKey = getFilePath('ca.key');
const caCert = getFilePath('ca.crt');
const serverKey = getFilePath('server.key');
const serverCsr = getFilePath('server.csr');
const serverSrl = getFilePath('server.srl');
const serverCert = getFilePath('server.crt');

// Device file paths
const csrFileName = 'app.csr';
const deviceCAcertFile = 'sonarCA.crt';
const deviceClientCertFile = 'device.crt';

const caSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=SonarCA';
const serverSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=localhost';
const minCertExpiryWindowSeconds = 24 * 60 * 60;
const allowedAppNameRegex = /^[\w.-]+$/;
const logTag = 'CertificateProvider';
/*
 * RFC2253 specifies the unamiguous x509 subject format.
 * However, even when specifying this, different openssl implementations
 * wrap it differently, e.g "subject=X" vs "subject= X".
 */
const x509SubjectCNRegex = /[=,]\s*CN=([^,]*)(,.*)?$/;

export type SecureServerConfig = {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  requestCert: boolean;
  rejectUnauthorized: boolean;
};

type CertificateProviderConfig = {
  idbPath: string;
  enableAndroid: boolean;
  enableIOS: boolean;
  androidHome: string;
  enablePhysicalIOS: boolean;
};

/*
 * This class is responsible for generating and deploying server and client
 * certificates to allow for secure communication between Flipper and apps.
 * It takes a Certificate Signing Request which was generated by the app,
 * using the app's public/private keypair.
 * With this CSR it uses the Flipper CA to sign a client certificate which it
 * deploys securely to the app.
 * It also deploys the Flipper CA cert to the app.
 * The app can trust a server if and only if it has a certificate signed by the
 * Flipper CA.
 */
export default class CertificateProvider {
  logger: Logger;
  _adb: Promise<ADBClient> | undefined;
  certificateSetup: Promise<void>;
  config: CertificateProviderConfig;
  server: ServerController;

  get adb(): Promise<ADBClient> {
    if (this.config.enableAndroid) {
      if (this._adb) {
        return this._adb;
      }
      throw new Error(`ADB initialisation was not not successful`);
    }
    throw new Error('Android is not enabled in settings');
  }

  constructor(
    server: ServerController,
    logger: Logger,
    config: CertificateProviderConfig,
  ) {
    this.logger = logger;
    // TODO: refactor this code to create promise lazily
    this._adb = config.enableAndroid
      ? (getAdbClient(config).catch((e) => {
          // make sure initialization failure is already logged
          const msg =
            'Failed to initialize ADB. Please disable Android support in settings, or configure a correct path';
          server.flipperServer.emit('notification', {
            type: 'error',
            title: 'Failed to initialise ADB',
            description: msg,
          });
          this._adb = undefined; // no adb client available
        }) as Promise<ADBClient>)
      : undefined;
    if (isTest()) {
      this.certificateSetup = Promise.reject(
        new Error('Server certificates not available in test'),
      );
    } else {
      this.certificateSetup = reportPlatformFailures(
        this.ensureServerCertExists(),
        'ensureServerCertExists',
      );
      // make sure initialization failure is already logged
      this.certificateSetup.catch((e) => {
        console.error('Failed to find or generate certificates', e);
      });
    }
    this.config = config;
    this.server = server;
  }

  private uploadFiles = async (
    zipPath: string,
    deviceID: string,
  ): Promise<void> => {
    const buff = await fs.readFile(zipPath);
    const file = new File([buff], 'certs.zip');
    return reportPlatformFailures(
      timeout(
        5 * 60 * 1000,
        internGraphPOSTAPIRequest('flipper/certificates', {
          certificate_zip: file,
          device_id: deviceID,
        }),
        'Timed out uploading Flipper certificates to WWW.',
      ),
      'uploadCertificates',
    );
  };

  async processCertificateSigningRequest(
    unsanitizedCsr: string,
    os: string,
    appDirectory: string,
    medium: CertificateExchangeMedium,
  ): Promise<{deviceId: string}> {
    const csr = this.santitizeString(unsanitizedCsr);
    if (csr === '') {
      return Promise.reject(new Error(`Received empty CSR from ${os} device`));
    }
    this.ensureOpenSSLIsAvailable();
    const rootFolder = await promisify(tmp.dir)();
    const certFolder = rootFolder + '/FlipperCerts/';
    const certsZipPath = rootFolder + '/certs.zip';
    await this.certificateSetup;
    const caCert = await this.getCACertificate();
    await this.deployOrStageFileForMobileApp(
      appDirectory,
      deviceCAcertFile,
      caCert,
      csr,
      os,
      medium,
      certFolder,
    );
    const clientCert = await this.generateClientCertificate(csr);
    await this.deployOrStageFileForMobileApp(
      appDirectory,
      deviceClientCertFile,
      clientCert,
      csr,
      os,
      medium,
      certFolder,
    );
    const appName = await this.extractAppNameFromCSR(csr);
    const deviceId =
      medium === 'FS_ACCESS'
        ? await this.getTargetDeviceId(os, appName, appDirectory, csr)
        : uuid();
    if (medium === 'WWW') {
      const zipPromise = new Promise((resolve, reject) => {
        const output = fs.createWriteStream(certsZipPath);
        const archive = archiver('zip', {
          zlib: {level: 9}, // Sets the compression level.
        });
        archive.directory(certFolder, false);
        output.on('close', function () {
          resolve(certsZipPath);
        });
        archive.on('warning', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.finalize();
      });

      await reportPlatformFailures(
        zipPromise,
        'www-certs-exchange-zipping-certs',
      );
      await reportPlatformFailures(
        this.uploadFiles(certsZipPath, deviceId),
        'www-certs-exchange-uploading-certs',
      );
    }
    return {
      deviceId,
    };
  }

  getTargetDeviceId(
    os: string,
    appName: string,
    appDirectory: string,
    csr: string,
  ): Promise<string> {
    if (os === 'Android') {
      return this.getTargetAndroidDeviceId(appName, appDirectory, csr);
    } else if (os === 'iOS') {
      return this.getTargetiOSDeviceId(appName, appDirectory, csr);
    } else if (os == 'MacOS') {
      return Promise.resolve('');
    }
    return Promise.resolve('unknown');
  }

  private ensureOpenSSLIsAvailable(): void {
    if (!opensslInstalled()) {
      const e = Error(
        "It looks like you don't have OpenSSL installed. Please install it to continue.",
      );
      this.server.emit('error', e);
    }
  }

  private getCACertificate(): Promise<string> {
    return fs.readFile(caCert, 'utf-8');
  }

  private generateClientCertificate(csr: string): Promise<string> {
    console.debug('Creating new client cert', logTag);

    return this.writeToTempFile(csr).then((path) => {
      return openssl('x509', {
        req: true,
        in: path,
        CA: caCert,
        CAkey: caKey,
        CAcreateserial: true,
        CAserial: serverSrl,
      });
    });
  }

  private getRelativePathInAppContainer(absolutePath: string) {
    const matches = /Application\/[^/]+\/(.*)/.exec(absolutePath);
    if (matches && matches.length === 2) {
      return matches[1];
    }
    throw new Error("Path didn't match expected pattern: " + absolutePath);
  }

  private async deployOrStageFileForMobileApp(
    destination: string,
    filename: string,
    contents: string,
    csr: string,
    os: string,
    medium: CertificateExchangeMedium,
    certFolder: string,
  ): Promise<void> {
    if (medium === 'WWW') {
      const certPathExists = await fs.pathExists(certFolder);
      if (!certPathExists) {
        await fs.mkdir(certFolder);
      }
      try {
        await fs.writeFile(certFolder + filename, contents);
        return;
      } catch (e) {
        throw new Error(
          `Failed to write ${filename} to temporary folder. Error: ${e}`,
        );
      }
    }

    const appName = await this.extractAppNameFromCSR(csr);

    if (os === 'Android') {
      const deviceId = await this.getTargetAndroidDeviceId(
        appName,
        destination,
        csr,
      );
      const adbClient = await this.adb;
      await androidUtil.push(
        adbClient,
        deviceId,
        appName,
        destination + filename,
        contents,
      );
    } else if (
      os === 'iOS' ||
      os === 'windows' ||
      os == 'MacOS' /* Used by Spark AR?! */
    ) {
      try {
        await fs.writeFile(destination + filename, contents);
      } catch (err) {
        // Writing directly to FS failed. It's probably a physical device.
        const relativePathInsideApp =
          this.getRelativePathInAppContainer(destination);
        const udid = await this.getTargetiOSDeviceId(appName, destination, csr);
        await this.pushFileToiOSDevice(
          udid,
          appName,
          relativePathInsideApp,
          filename,
          contents,
        );
      }
    } else {
      throw new Error(`Unsupported device OS for Certificate Exchange: ${os}`);
    }
  }

  private async pushFileToiOSDevice(
    udid: string,
    bundleId: string,
    destination: string,
    filename: string,
    contents: string,
  ): Promise<void> {
    const dir = await tmpDir({unsafeCleanup: true});
    const filePath = path.resolve(dir, filename);
    await fs.writeFile(filePath, contents);
    await iosUtil.push(
      udid,
      filePath,
      bundleId,
      destination,
      this.config.idbPath,
    );
  }

  private async getTargetAndroidDeviceId(
    appName: string,
    deviceCsrFilePath: string,
    csr: string,
  ): Promise<string> {
    const devicesInAdb = await this.adb.then((client) => client.listDevices());
    if (devicesInAdb.length === 0) {
      throw new Error('No Android devices found');
    }
    const deviceMatchList = devicesInAdb.map(async (device) => {
      try {
        const result = await this.androidDeviceHasMatchingCSR(
          deviceCsrFilePath,
          device.id,
          appName,
          csr,
        );
        return {id: device.id, ...result, error: null};
      } catch (e) {
        console.warn(
          `Unable to check for matching CSR in ${device.id}:${appName}`,
          logTag,
          e,
        );
        return {id: device.id, isMatch: false, foundCsr: null, error: e};
      }
    });
    const devices = await Promise.all(deviceMatchList);
    const matchingIds = devices.filter((m) => m.isMatch).map((m) => m.id);
    if (matchingIds.length == 0) {
      const erroredDevice = devices.find((d) => d.error);
      if (erroredDevice) {
        throw erroredDevice.error;
      }
      const foundCsrs = devices
        .filter((d) => d.foundCsr !== null)
        .map((d) => (d.foundCsr ? encodeURI(d.foundCsr) : 'null'));
      console.warn(`Looking for CSR (url encoded):

            ${encodeURI(this.santitizeString(csr))}

            Found these:

            ${foundCsrs.join('\n\n')}`);
      throw new Error(`No matching device found for app: ${appName}`);
    }
    if (matchingIds.length > 1) {
      console.warn(
        new Error('[conn] More than one matching device found for CSR'),
        csr,
      );
    }
    return matchingIds[0];
  }

  private async getTargetiOSDeviceId(
    appName: string,
    deviceCsrFilePath: string,
    csr: string,
  ): Promise<string> {
    const matches = /\/Devices\/([^/]+)\//.exec(deviceCsrFilePath);
    if (matches && matches.length == 2) {
      // It's a simulator, the deviceId is in the filepath.
      return matches[1];
    }
    const targets = await iosUtil.targets(
      this.config.idbPath,
      this.config.enablePhysicalIOS,
    );
    if (targets.length === 0) {
      throw new Error('No iOS devices found');
    }
    const deviceMatchList = targets.map(async (target) => {
      const isMatch = await this.iOSDeviceHasMatchingCSR(
        deviceCsrFilePath,
        target.udid,
        appName,
        csr,
      );
      return {id: target.udid, isMatch};
    });
    const devices = await Promise.all(deviceMatchList);
    const matchingIds = devices.filter((m) => m.isMatch).map((m) => m.id);
    if (matchingIds.length == 0) {
      throw new Error(`No matching device found for app: ${appName}`);
    }
    if (matchingIds.length > 1) {
      console.warn(`Multiple devices found for app: ${appName}`);
    }
    return matchingIds[0];
  }

  private async androidDeviceHasMatchingCSR(
    directory: string,
    deviceId: string,
    processName: string,
    csr: string,
  ): Promise<{isMatch: boolean; foundCsr: string}> {
    const adbClient = await this.adb;
    const deviceCsr = await androidUtil.pull(
      adbClient,
      deviceId,
      processName,
      directory + csrFileName,
    );
    // Santitize both of the string before comparation
    // The csr string extraction on client side return string in both way
    const [sanitizedDeviceCsr, sanitizedClientCsr] = [
      deviceCsr.toString(),
      csr,
    ].map((s) => this.santitizeString(s));
    const isMatch = sanitizedDeviceCsr === sanitizedClientCsr;
    return {isMatch: isMatch, foundCsr: sanitizedDeviceCsr};
  }

  private async iOSDeviceHasMatchingCSR(
    directory: string,
    deviceId: string,
    bundleId: string,
    csr: string,
  ): Promise<boolean> {
    const originalFile = this.getRelativePathInAppContainer(
      path.resolve(directory, csrFileName),
    );
    const dir = await tmpDir({unsafeCleanup: true});
    await iosUtil.pull(
      deviceId,
      originalFile,
      bundleId,
      dir,
      this.config.idbPath,
    );
    const items = await fs.readdir(dir);
    if (items.length > 1) {
      throw new Error('Conflict in temp dir');
    }
    if (items.length === 0) {
      throw new Error('Failed to pull CSR from device');
    }
    const fileName = items[0];
    const copiedFile = path.resolve(dir, fileName);
    console.debug('Trying to read CSR from', copiedFile);
    const data = await fs.readFile(copiedFile);
    const csrFromDevice = this.santitizeString(data.toString());
    return csrFromDevice === this.santitizeString(csr);
  }

  private santitizeString(csrString: string): string {
    return csrString.replace(/\r/g, '').trim();
  }

  async extractAppNameFromCSR(csr: string): Promise<string> {
    const path = await this.writeToTempFile(csr);
    const subject = await openssl('req', {
      in: path,
      noout: true,
      subject: true,
      nameopt: true,
      RFC2253: false,
    });
    await fs.unlink(path);
    const matches = subject.trim().match(x509SubjectCNRegex);
    if (!matches || matches.length < 2) {
      throw new Error(`Cannot extract CN from ${subject}`);
    }
    const appName = matches[1];
    if (!appName.match(allowedAppNameRegex)) {
      throw new Error(
        `Disallowed app name in CSR: ${appName}. Only alphanumeric characters and '.' allowed.`,
      );
    }
    return appName;
  }

  async loadSecureServerConfig(): Promise<SecureServerConfig> {
    await this.certificateSetup;
    return {
      key: await fs.readFile(serverKey),
      cert: await fs.readFile(serverCert),
      ca: await fs.readFile(caCert),
      requestCert: true,
      rejectUnauthorized: true, // can be false if necessary as we don't strictly need to verify the client
    };
  }

  async ensureCertificateAuthorityExists(): Promise<void> {
    if (!(await fs.pathExists(caKey))) {
      return this.generateCertificateAuthority();
    }
    return this.checkCertIsValid(caCert).catch(() =>
      this.generateCertificateAuthority(),
    );
  }

  private async checkCertIsValid(filename: string): Promise<void> {
    if (!(await fs.pathExists(filename))) {
      throw new Error(`${filename} does not exist`);
    }
    // openssl checkend is a nice feature but it only checks for certificates
    // expiring in the future, not those that have already expired.
    // So we need a separate check for certificates that have already expired
    // but since this involves parsing date outputs from openssl, which is less
    // reliable, keeping both checks for safety.
    try {
      await openssl('x509', {
        checkend: minCertExpiryWindowSeconds,
        in: filename,
      });
    } catch (e) {
      console.warn(
        `Checking if certificate expire soon: ${filename}`,
        logTag,
        e,
      );
      const endDateOutput = await openssl('x509', {
        enddate: true,
        in: filename,
        noout: true,
      });
      const dateString = endDateOutput.trim().split('=')[1].trim();
      const expiryDate = Date.parse(dateString);
      if (isNaN(expiryDate)) {
        console.error(
          'Unable to parse certificate expiry date: ' + endDateOutput,
        );
        throw new Error(
          'Cannot parse certificate expiry date. Assuming it has expired.',
        );
      }
      if (expiryDate <= Date.now() + minCertExpiryWindowSeconds * 1000) {
        throw new Error('Certificate has expired or will expire soon.');
      }
    }
  }

  private async verifyServerCertWasIssuedByCA() {
    const options: {
      [key: string]: any;
    } = {CAfile: caCert};
    options[serverCert] = false;
    const output = await openssl('verify', options);
    const verified = output.match(/[^:]+: OK/);
    if (!verified) {
      // This should never happen, but if it does, we need to notice so we can
      // generate a valid one, or no clients will trust our server.
      throw new Error('Current server cert was not issued by current CA');
    }
  }

  private async generateCertificateAuthority(): Promise<void> {
    if (!(await fs.pathExists(getFilePath('')))) {
      await fs.mkdir(getFilePath(''));
    }
    console.log('Generating new CA', logTag);
    await openssl('genrsa', {out: caKey, '2048': false});
    await openssl('req', {
      new: true,
      x509: true,
      subj: caSubject,
      key: caKey,
      out: caCert,
    });
  }

  private async ensureServerCertExists(): Promise<void> {
    const allExist = await Promise.all([
      fs.pathExists(serverKey),
      fs.pathExists(serverCert),
      fs.pathExists(caCert),
    ]).then((exist) => exist.every(Boolean));
    if (!allExist) {
      return this.generateServerCertificate();
    }

    try {
      await this.checkCertIsValid(serverCert);
      await this.verifyServerCertWasIssuedByCA();
    } catch (e) {
      console.warn('Not all certs are valid, generating new ones', e);
      await this.generateServerCertificate();
    }
  }

  private async generateServerCertificate(): Promise<void> {
    await this.ensureCertificateAuthorityExists();
    console.warn('Creating new server cert', logTag);
    await openssl('genrsa', {out: serverKey, '2048': false});
    await openssl('req', {
      new: true,
      key: serverKey,
      out: serverCsr,
      subj: serverSubject,
    });
    await openssl('x509', {
      req: true,
      in: serverCsr,
      CA: caCert,
      CAkey: caKey,
      CAcreateserial: true,
      CAserial: serverSrl,
      out: serverCert,
    });
  }

  private async writeToTempFile(content: string): Promise<string> {
    const path = await tmpFile();
    await fs.writeFile(path, content);
    return path;
  }
}

function getFilePath(fileName: string): string {
  return path.resolve(os.homedir(), '.flipper', 'certs', fileName);
}
