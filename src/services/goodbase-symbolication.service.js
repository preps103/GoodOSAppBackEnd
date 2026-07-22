"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { SourceMapConsumer } = require("source-map");
const database = require("../config/database");

const storageRoot = path.resolve(process.env.GOODBASE_SYMBOL_STORAGE_ROOT || "/var/lib/goodapp-backend/symbols");
const symbolTypes = new Set(["sourcemap", "dsym", "proguard", "ndk", "flutter", "unity"]);
const extensions = { sourcemap:"map", dsym:"dsym", proguard:"txt", ndk:"sym", flutter:"symbols", unity:"sym" };
const maximumBytes = 50 * 1024 * 1024;

function safeUuid(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text) ? text : null;
}

function clean(value, maximum = 300) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function safeStoragePath(releaseId, checksum, type) {
  const target = path.resolve(storageRoot, releaseId, `${checksum}.${extensions[type]}`);
  if (!target.startsWith(`${storageRoot}${path.sep}`)) throw new Error("Symbol storage path is invalid.");
  return target;
}

function isMachO(contents) {
  if (contents.length < 4) return false;
  return [0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe,0xcafebabe,0xbebafeca].includes(contents.readUInt32BE(0));
}

function isElf(contents) {
  return contents.length > 4 && contents[0] === 0x7f && contents.subarray(1,4).toString("ascii") === "ELF";
}

function validateSymbol(type, contents) {
  if (!symbolTypes.has(type)) throw Object.assign(new Error("Unsupported symbol type."), { statusCode:400 });
  if (!Buffer.isBuffer(contents) || contents.length < 2 || contents.length > maximumBytes) {
    throw Object.assign(new Error(`Symbol files must be between 2 bytes and ${maximumBytes} bytes.`), { statusCode:400 });
  }
  if (type === "sourcemap") {
    let parsed;
    try { parsed = JSON.parse(contents.toString("utf8")); } catch { throw Object.assign(new Error("The source map is not valid JSON."), { statusCode:400 }); }
    if (Number(parsed.version) !== 3 || typeof parsed.mappings !== "string") throw Object.assign(new Error("Only Source Map v3 files are supported."), { statusCode:400 });
    return { contents:Buffer.from(JSON.stringify(parsed)), tool:"source-map-v3", metadata:{format:"json"} };
  }
  const text = contents.toString("utf8");
  if (type === "proguard") {
    if (!/^\S.+\s+->\s+\S+:$/m.test(text)) throw Object.assign(new Error("A valid ProGuard/R8 mapping file is required."), { statusCode:400 });
    return { contents, tool:"goodbase-retrace", metadata:{format:"proguard-mapping"} };
  }
  if (type === "dsym" && !isMachO(contents)) throw Object.assign(new Error("Upload the Mach-O DWARF binary from the dSYM bundle."), { statusCode:400 });
  if (["ndk","unity"].includes(type) && !(isElf(contents) || /^MODULE\s+/m.test(text) || /^FUNC\s+[0-9a-f]+\s+/mi.test(text))) {
    throw Object.assign(new Error("Upload an ELF debug object or Breakpad symbol file."), { statusCode:400 });
  }
  if (type === "flutter" && !(isElf(contents) || /(?:^|\n)(?:0x)?[0-9a-f]{6,}\s+\S+/i.test(text))) {
    throw Object.assign(new Error("Upload a Flutter split-debug-info symbol file."), { statusCode:400 });
  }
  return { contents, tool:isElf(contents)||isMachO(contents)?"llvm-symbolizer":"goodbase-symbol-table", metadata:{format:isElf(contents)?"elf":isMachO(contents)?"mach-o":"text-symbols"} };
}

async function saveSymbolFile({ scope, releaseId, symbolType, contents, filename, contentType, metadata = {} }) {
  const normalizedReleaseId = safeUuid(releaseId), type = clean(symbolType,20).toLowerCase();
  if (!normalizedReleaseId) throw Object.assign(new Error("A valid client release is required."), { statusCode:400 });
  const release = await database.query(`SELECT id,platform,version,build_number FROM goodbase_client_releases WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4`,[normalizedReleaseId,scope.organizationId,scope.projectId,scope.environmentId]);
  if (!release.rows[0]) throw Object.assign(new Error("Client release not found."), { statusCode:404 });
  const validated = validateSymbol(type, contents);
  const checksum = crypto.createHash("sha256").update(validated.contents).digest("hex"), target = safeStoragePath(normalizedReleaseId,checksum,type);
  await fs.promises.mkdir(path.dirname(target),{recursive:true,mode:0o750});
  if (!fs.existsSync(target)) {
    const staging = `${target}.${process.pid}.${crypto.randomUUID()}.uploading`;
    await fs.promises.writeFile(staging,validated.contents,{mode:0o640,flag:"wx"});
    await fs.promises.rename(staging,target);
  }
  const stored=await database.query(`INSERT INTO goodbase_symbol_files(release_id,symbol_type,checksum_sha256,storage_ref,status,original_filename,content_type,size_bytes,processing_tool,metadata_json,verified_at) VALUES($1,$2,$3,$4,'ready',$5,$6,$7,$8,$9::jsonb,NOW()) ON CONFLICT(release_id,symbol_type,checksum_sha256) DO UPDATE SET storage_ref=EXCLUDED.storage_ref,status='ready',original_filename=EXCLUDED.original_filename,content_type=EXCLUDED.content_type,size_bytes=EXCLUDED.size_bytes,processing_tool=EXCLUDED.processing_tool,metadata_json=EXCLUDED.metadata_json,verified_at=NOW() RETURNING id,release_id,symbol_type,checksum_sha256,status,size_bytes,processing_tool,verified_at`,[normalizedReleaseId,type,checksum,target,clean(filename,300)||null,clean(contentType,120)||null,validated.contents.length,validated.tool,JSON.stringify({...validated.metadata,...metadata})]);
  return stored.rows[0];
}

async function saveSourceMap(input) { return saveSymbolFile({...input,symbolType:"sourcemap",filename:input.filename||"source.map",contentType:input.contentType||"application/json"}); }

async function findRelease({ scope, appId, releaseId, releaseName, platform, buildNumber }) {
  const normalizedReleaseId=safeUuid(releaseId);
  const result=await database.query(`SELECT id FROM goodbase_client_releases WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND app_id=$4 AND (($5::uuid IS NOT NULL AND id=$5::uuid) OR ($5::uuid IS NULL AND (version=$6 OR version||'+'||build_number=$6) AND ($7='' OR platform=$7) AND ($8='' OR build_number=$8))) ORDER BY released_at DESC LIMIT 1`,[scope.organizationId,scope.projectId,scope.environmentId,appId,normalizedReleaseId,String(releaseName||"").slice(0,100),clean(platform,30),clean(buildNumber,100)]);
  return result.rows[0]?.id||null;
}

function retraceProguard(stack, mapping) {
  const classes=new Map();
  for(const line of mapping.split(/\r?\n/)){const match=line.match(/^(\S.*?)\s+->\s+(\S+):$/);if(match)classes.set(match[2],match[1]);}
  let replacements=0;
  const output=String(stack).replace(/\bat\s+([\w$]+(?:\.[\w$]+)*)\.([\w$<>]+)\(/g,(full,className,method)=>{const original=classes.get(className);if(!original)return full;replacements+=1;return `at ${original}.${method}(`;});
  return {stack:output,symbolicated:replacements>0,replacements,tool:"goodbase-retrace"};
}

function textSymbolicate(stack, symbols) {
  const table=[];
  for(const line of symbols.split(/\r?\n/)){
    let match=line.match(/^FUNC\s+([0-9a-f]+)\s+[0-9a-f]+\s+\S+\s+(.+)$/i)||line.match(/^(?:0x)?([0-9a-f]{6,})\s+(.+)$/i);
    if(match)table.push([Number.parseInt(match[1],16),match[2].trim()]);
  }
  table.sort((a,b)=>a[0]-b[0]);let replacements=0;
  const output=String(stack).replace(/0x([0-9a-f]{6,})/gi,(full,hex)=>{const address=Number.parseInt(hex,16);let found=null;for(const entry of table){if(entry[0]>address)break;found=entry;}if(!found)return full;replacements+=1;return `${found[1]}+0x${(address-found[0]).toString(16)} [${full}]`;});
  return {stack:output,symbolicated:replacements>0,replacements,tool:"goodbase-symbol-table"};
}

function llvmSymbolicate(stack, objectPath) {
  const addresses=[...new Set(String(stack).match(/0x[0-9a-f]{6,}/gi)||[])];
  if(!addresses.length)return Promise.resolve({stack,symbolicated:false,replacements:0,tool:"llvm-symbolizer"});
  const executable=process.env.GOODBASE_LLVM_SYMBOLIZER||"llvm-symbolizer";
  return new Promise(resolve=>{
    let timer;
    const child=spawn(executable,[`--obj=${objectPath}`,"--functions=linkage","--inlines"],{stdio:["pipe","pipe","ignore"]});let output="",finished=false;
    const done=result=>{if(finished)return;finished=true;clearTimeout(timer);resolve(result);};
    child.stdout.on("data",chunk=>{if(output.length<1024*1024)output+=chunk;});
    child.on("error",()=>done({stack,symbolicated:false,replacements:0,tool:"llvm-symbolizer-unavailable"}));
    child.on("close",code=>{if(code!==0)return done({stack,symbolicated:false,replacements:0,tool:"llvm-symbolizer-failed"});const groups=output.trim().split(/\n\n+/),mapped=new Map();addresses.forEach((address,index)=>{const value=groups[index]?.trim();if(value&&value!=="??\n??:0:0")mapped.set(address.toLowerCase(),value.replace(/\n/g," @ "));});let replacements=0;const result=String(stack).replace(/0x[0-9a-f]{6,}/gi,value=>{const symbol=mapped.get(value.toLowerCase());if(!symbol)return value;replacements+=1;return `${symbol} [${value}]`;});done({stack:result,symbolicated:replacements>0,replacements,tool:"llvm-symbolizer"});});
    child.stdin.end(`${addresses.join("\n")}\n`);timer=setTimeout(()=>{child.kill("SIGKILL");done({stack,symbolicated:false,replacements:0,tool:"llvm-symbolizer-timeout"});},5000);
  });
}

async function symbolicateStack({ releaseId, stack, platform }) {
  if(!releaseId||!stack)return{stack,symbolicated:false,replacements:0,tool:null};
  const preferred=/android/i.test(platform||"")?["proguard","ndk"]:/ios|macos/i.test(platform||"")?["dsym"]:/flutter/i.test(platform||"")?["flutter"]:/unity/i.test(platform||"")?["unity"]:["sourcemap"];
  const found=await database.query(`SELECT symbol_type,storage_ref,processing_tool FROM goodbase_symbol_files WHERE release_id=$1 AND status='ready' ORDER BY array_position($2::text[],symbol_type),created_at DESC`,[releaseId,preferred]);
  for(const item of found.rows){const storageRef=path.resolve(item.storage_ref||"");if(!storageRef.startsWith(`${storageRoot}${path.sep}`)||!fs.existsSync(storageRef))continue;try{if(item.symbol_type==="sourcemap"){const raw=JSON.parse(await fs.promises.readFile(storageRef,"utf8")),lines=String(stack).split("\n");let replacements=0;const mapped=await SourceMapConsumer.with(raw,null,consumer=>lines.map(line=>{const match=line.match(/^(.*?)([^\s()]+):(\d+):(\d+)(\)?)$/);if(!match)return line;const original=consumer.originalPositionFor({line:Number(match[3]),column:Number(match[4])});if(!original.source||original.line==null)return line;replacements+=1;return `${match[1]}${original.name?`${original.name} `:""}(${original.source}:${original.line}:${original.column})`;}));if(replacements)return{stack:mapped.join("\n"),symbolicated:true,replacements,tool:"source-map-v3"};}else if(item.symbol_type==="proguard"){const result=retraceProguard(stack,await fs.promises.readFile(storageRef,"utf8"));if(result.symbolicated)return result;}else if(item.processing_tool==="goodbase-symbol-table"){const result=textSymbolicate(stack,await fs.promises.readFile(storageRef,"utf8"));if(result.symbolicated)return result;}else{const result=await llvmSymbolicate(stack,storageRef);if(result.symbolicated)return result;}}catch{/* Try the next verified artifact. */}}
  return{stack,symbolicated:false,replacements:0,tool:null};
}

module.exports={saveSymbolFile,saveSourceMap,findRelease,symbolicateStack,retraceProguard,textSymbolicate,validateSymbol,symbolTypes,maximumBytes};
