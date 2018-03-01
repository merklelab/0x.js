import { Callback, NextCallback, Subprovider } from '@0xproject/subproviders';
import { promisify } from '@0xproject/utils';
import * as fs from 'fs';
import * as glob from 'glob';
import { Collector } from 'istanbul';
import * as _ from 'lodash';
import * as path from 'path';
import * as instrumentSolidity from 'solidity-coverage/lib/instrumentSolidity.js';
import * as Web3 from 'web3';

import { parseSourceMap } from './source_maps';
import { LineColumn, SingleFileSourceRange, SourceRange } from './types';

export interface LineCoverage {
    [lineNo: number]: number;
}

export interface FunctionCoverage {
    [functionId: number]: number;
}

export interface StatementCoverage {
    [statementId: number]: number;
}

export interface BranchCoverage {
    [branchId: number]: number;
}

export interface FunctionDescription {
    name: string;
    line: number;
    loc: {
        start: LineColumn;
        end: LineColumn;
    };
    skip?: boolean;
}

export interface FinalCoverage {
    [fineName: string]: {
        l: LineCoverage;
        f: FunctionCoverage;
        s: StatementCoverage;
        b: BranchCoverage;
        fnMap: {
            [functionId: number]: FunctionDescription;
        };
        branchMap: any;
        statementMap: any;
        path: string;
    };
}

interface ContractData {
    runtimeBytecode: string;
    sourceMapRuntime: string;
    sourceCodes: string[];
    baseName: string;
    sources: string[];
}

const compareLineColumn = (lhs: LineColumn, rhs: LineColumn) => {
    return lhs.line !== rhs.line ? lhs.line - rhs.line : lhs.column - rhs.column;
};

const isRangeInside = (childRange: SingleFileSourceRange, parentRange: SingleFileSourceRange) => {
    return (
        compareLineColumn(parentRange.start, childRange.start) <= 0 &&
        compareLineColumn(childRange.end, parentRange.end) <= 0
    );
};

/*
 * This class implements the web3-provider-engine subprovider interface and collects traces of all transactions that were sent.
 * Source: https://github.com/MetaMask/provider-engine/blob/master/subproviders/subprovider.js
 */
export class CoverageSubprovider extends Subprovider {
    private _tracesByAddress: { [address: string]: Web3.TransactionTrace[] } = {};
    private _contractsData: ContractData[] = [];
    constructor(artifactsPath: string, sourcesPath: string, networkId: number) {
        super();
        const sourcesGlob = `${sourcesPath}/**/*.sol`;
        const sourceFileNames = glob.sync(sourcesGlob, { absolute: true });
        for (const sourceFileName of sourceFileNames) {
            const baseName = path.basename(sourceFileName, '.sol');
            const artifactFileName = path.join(artifactsPath, `${baseName}.json`);
            if (!fs.existsSync(artifactFileName)) {
                // If the contract isn't directly compiled, but is imported as the part of the other contract - we don't have an artifact for it and therefore can't do anything usefull with it
                continue;
            }
            const artifact = JSON.parse(fs.readFileSync(artifactFileName).toString());
            const sources = _.map(artifact.networks[networkId].sources, source => {
                const includedFileName = glob.sync(`${sourcesPath}/**/${source}`, { absolute: true })[0];
                return includedFileName;
            });
            const sourceCodes = _.map(sources, source => {
                const includedSourceCode = fs.readFileSync(source).toString();
                return includedSourceCode;
            });
            const contractData = {
                baseName,
                sourceCodes,
                sources,
                sourceMapRuntime: artifact.networks[networkId].source_map_runtime,
                runtimeBytecode: artifact.networks[networkId].runtime_bytecode,
            };
            this._contractsData.push(contractData);
        }
    }
    // This method needs to be here to satisfy the interface but linter wants it to be static.
    // tslint:disable-next-line:prefer-function-over-method
    public handleRequest(
        payload: Web3.JSONRPCRequestPayload,
        next: NextCallback,
        end: (err: Error | null, result: any) => void,
    ) {
        switch (payload.method) {
            case 'eth_sendTransaction':
                const toAddress = payload.params[0].to;
                next(this._onTransactionSentAsync.bind(this, toAddress));
                return;

            default:
                next();
                return;
        }
    }
    public async computeCoverageAsync(): Promise<FinalCoverage> {
        const collector = new Collector();
        for (const address of _.keys(this._tracesByAddress)) {
            const runtimeBytecode = await this._getContractCodeAsync(address);
            const contractData = _.find(this._contractsData, { runtimeBytecode });
            if (_.isUndefined(contractData)) {
                throw new Error(`Transaction to an unknown address: ${address}`);
            }
            const bytecodeHex = contractData.runtimeBytecode.slice(2);
            const pcToSourceRange = parseSourceMap(
                contractData.sourceCodes,
                contractData.sourceMapRuntime,
                bytecodeHex,
                contractData.sources,
            );
            for (let i = 0; i < contractData.sources.length; i++) {
                const lineCoverage: LineCoverage = {};
                const functionCoverage: FunctionCoverage = {};
                const fileName = contractData.sources[i];
                const instrumentedSolidity = instrumentSolidity(contractData.sourceCodes[i], fileName);
                _.forEach(instrumentedSolidity.runnableLines, lineNo => (lineCoverage[lineNo] = 0));
                _.forEach(_.values(this._tracesByAddress[address]), trace => {
                    const sourceRangesIfExist = _.map(trace.structLogs, log => pcToSourceRange[log.pc]);
                    const sourceRanges = _.compact(sourceRangesIfExist);
                    const sourceRangesInCurrentFile = _.filter(
                        sourceRanges,
                        sourceRange => sourceRange.fileName === fileName,
                    );
                    const lineNumbers = _.map(
                        sourceRangesInCurrentFile,
                        sourceRangeInCurrentFile => sourceRangeInCurrentFile.location.start.line,
                    );
                    const uniqueLineNumbers = _.uniq(lineNumbers);
                    _.forEach(uniqueLineNumbers, lineNo => (lineCoverage[lineNo] = (lineCoverage[lineNo] || 0) + 1));
                    _.forEach(
                        instrumentedSolidity.fnMap,
                        (functionDescription: FunctionDescription, functionId: number) => {
                            const isFunctionCovered = _.some(
                                sourceRangesInCurrentFile,
                                sourceRangeInCurrentFile =>
                                    functionDescription.line === sourceRangeInCurrentFile.location.start.line, // TODO Figure out a less hacky way
                            );
                            functionCoverage[functionId] =
                                (functionCoverage[functionId] || 0) + (isFunctionCovered ? 1 : 0);
                        },
                    );
                });
                const partialCoverage = {
                    [contractData.sources[i]]: {
                        fnMap: instrumentedSolidity.fnMap,
                        branchMap: instrumentedSolidity.branchMap,
                        statementMap: instrumentSolidity.statementMap,
                        l: lineCoverage,
                        path: fileName,
                        f: functionCoverage,
                        s: {},
                        b: {},
                    },
                };
                collector.add(partialCoverage);
            }
        }
        return (collector as any).getFinalCoverage();
    }
    public async writeCoverageAsync(): Promise<void> {
        const finalCoverage = await this.computeCoverageAsync();
        fs.writeFileSync('coverage/coverage.json', JSON.stringify(finalCoverage, null, 2));
    }
    private async _onTransactionSentAsync(
        address: string,
        err: Error | null,
        txHash: string,
        cb: Callback,
    ): Promise<void> {
        if (_.isNull(err)) {
            await this._recordTxTraceAsync(address, txHash);
            cb();
        } else {
            const payload = {
                method: 'eth_getBlockByNumber',
                params: ['latest', true],
            };
            const jsonRPCResponsePayload = await this.emitPayloadAsync(payload);
            const transactions = jsonRPCResponsePayload.result.transactions;
            for (const transaction of transactions) {
                await this._recordTxTraceAsync(transaction.to, transaction.hash);
            }
            cb();
        }
    }
    private async _recordTxTraceAsync(address: string, txHash: string): Promise<void> {
        if (_.isUndefined(address)) {
            // TODO Handle creation of new contracts
            return;
        }
        const payload = {
            method: 'debug_traceTransaction',
            params: [txHash, {}],
        };
        const jsonRPCResponsePayload = await this.emitPayloadAsync(payload);
        const trace: Web3.TransactionTrace = jsonRPCResponsePayload.result;
        this._tracesByAddress[address] = [...(this._tracesByAddress[address] || []), trace];
    }
    private async _getContractCodeAsync(address: string): Promise<string> {
        const payload = {
            method: 'eth_getCode',
            params: [address, 'latest'],
        };
        const jsonRPCResponsePayload = await this.emitPayloadAsync(payload);
        const contractCode: string = jsonRPCResponsePayload.result;
        return contractCode;
    }
}
