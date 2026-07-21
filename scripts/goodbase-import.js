#!/usr/bin/env node
"use strict";

const crypto=require("crypto");const fs=require("fs");const path=require("path");
const supported=new Set(["supabase","firebase_auth","firestore","firebase_storage","postgresql","environment"]);
function usage(){console.error("Usage: goodbase-import analyze --source <type> --file <manifest.json>");process.exit(2);}
const args=process.argv.slice(2);if(args[0]!=="analyze")usage();const source=args[args.indexOf("--source")+1];const file=args[args.indexOf("--file")+1];if(!supported.has(source)||!file)usage();
const absolute=path.resolve(file);const raw=fs.readFileSync(absolute,"utf8");const parsed=JSON.parse(raw);const findings=[];
function finding(severity,category,message,remediation){findings.push({severity,category,message,remediation});}
if(source==="firebase_auth"&&!Array.isArray(parsed.users))finding("blocking","shape","Firebase Auth export must contain a users array.","Export users with the Firebase Admin SDK format.");
if(source==="firestore"&&!parsed.collections)finding("blocking","shape","Firestore manifest must define collections.","Export collection names, document counts, indexes and field types.");
if(source==="supabase"&&!parsed.schemas)finding("warning","schema","Supabase manifest does not list schemas.","Include schemas, policies, functions, publications and Storage buckets.");
if(source==="postgresql"&&!parsed.serverVersion)finding("warning","compatibility","PostgreSQL server version is missing.","Include serverVersion and required extensions.");
if(source==="environment"){const keys=Object.keys(parsed);for(const key of keys)if(/SECRET|PASSWORD|TOKEN|PRIVATE/i.test(key))finding("warning","secret",`Sensitive variable ${key} must be imported as a secret reference.`,"Create the secret in Goodbase Vault and map only its secret:// reference.");}
const report={source,file:path.basename(absolute),fingerprint:crypto.createHash("sha256").update(raw).digest("hex"),status:findings.some(item=>item.severity==="blocking")?"blocked":"ready",counts:{records:Array.isArray(parsed.users)?parsed.users.length:Object.keys(parsed).length,findings:findings.length},findings,applyRequires:{mfa:true,rollbackRef:true,controller:"infrastructure"}};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);if(report.status==="blocked")process.exitCode=1;
