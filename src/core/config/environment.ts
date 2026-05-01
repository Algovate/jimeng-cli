import path from 'path';

import fs from 'fs-extra';
import minimist from 'minimist';
import _ from 'lodash';

import pkg from '../../../package.json' with { type: 'json' };

const cmdArgs = minimist(process.argv.slice(2));  //获取命令行参数
const envVars = process.env;  //获取环境变量

class Environment {

    /** 命令行参数 */
    cmdArgs: any;
    /** 环境变量 */
    envVars: any;
    /** 环境名称 */
    env?: string;
    /** 包参数 */
    package: any;

    constructor(options: any = {}) {
        const { cmdArgs, envVars, package: _package } = options;
        this.cmdArgs = cmdArgs;
        this.envVars = envVars;
        this.env = _.defaultTo(cmdArgs.env || envVars.SERVER_ENV, 'dev');
        this.package = _package;
    }

}

export default new Environment({
    cmdArgs,
    envVars,
    package: pkg
});
