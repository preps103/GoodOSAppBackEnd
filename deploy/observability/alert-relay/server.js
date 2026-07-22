"use strict";
const http=require("http"),crypto=require("crypto"),fs=require("fs");
const port=Number(process.env.PORT||8080),target=process.env.GOODBASE_ALERT_RECEIVER_URL||"https://base.goodos.app/api/internal/observability/alerts";
const secretPath=process.env.GOODBASE_ALERT_WEBHOOK_SECRET_FILE||"/run/secrets/alert_webhook_secret";
const stats={received:0,delivered:0,failed:0,retries:0,lastSuccess:0,lastFailure:0};
function secret(){return fs.readFileSync(secretPath,"utf8").trim();}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function deliver(body){
  let error;for(let attempt=0;attempt<4;attempt+=1){
    const timestamp=String(Date.now()),nonce=crypto.randomUUID(),signature=crypto.createHmac("sha256",secret()).update(`${timestamp}.${nonce}.${body}`).digest("hex");
    try{const response=await fetch(target,{method:"POST",headers:{"content-type":"application/json","user-agent":"Goodbase-Alert-Relay/1.0","x-goodbase-timestamp":timestamp,"x-goodbase-nonce":nonce,"x-goodbase-signature":`sha256=${signature}`},body,signal:AbortSignal.timeout(10_000)});if(response.ok){stats.delivered+=1;stats.lastSuccess=Date.now()/1000;return response.status;}error=new Error(`receiver returned ${response.status}`);if(response.status<500&&response.status!==429)break;}catch(caught){error=caught;}if(attempt<3){stats.retries+=1;await sleep(Math.min(8000,500*2**attempt));}}
  stats.failed+=1;stats.lastFailure=Date.now()/1000;throw error||new Error("delivery failed");
}
function metrics(){return `# HELP goodbase_alert_relay_received_total Alertmanager webhook requests received.\n# TYPE goodbase_alert_relay_received_total counter\ngoodbase_alert_relay_received_total ${stats.received}\n# HELP goodbase_alert_relay_delivered_total Receiver deliveries accepted.\n# TYPE goodbase_alert_relay_delivered_total counter\ngoodbase_alert_relay_delivered_total ${stats.delivered}\n# HELP goodbase_alert_relay_failed_total Receiver deliveries exhausted.\n# TYPE goodbase_alert_relay_failed_total counter\ngoodbase_alert_relay_failed_total ${stats.failed}\n# HELP goodbase_alert_relay_retries_total Receiver delivery retries.\n# TYPE goodbase_alert_relay_retries_total counter\ngoodbase_alert_relay_retries_total ${stats.retries}\n# TYPE goodbase_alert_relay_last_success_timestamp_seconds gauge\ngoodbase_alert_relay_last_success_timestamp_seconds ${stats.lastSuccess}\n# TYPE goodbase_alert_relay_last_failure_timestamp_seconds gauge\ngoodbase_alert_relay_last_failure_timestamp_seconds ${stats.lastFailure}\n`;}
http.createServer((request,response)=>{
  if(request.method==="GET"&&request.url==="/healthz"){try{secret();response.writeHead(200);return response.end("ok");}catch{response.writeHead(503);return response.end("secret unavailable");}}
  if(request.method==="GET"&&request.url==="/metrics"){response.writeHead(200,{"content-type":"text/plain; version=0.0.4"});return response.end(metrics());}
  if(request.method!=="POST"||request.url!=="/v1/alerts"){response.writeHead(404);return response.end();}
  let body="",size=0;request.on("data",chunk=>{size+=chunk.length;if(size>1024*1024){request.destroy();return;}body+=chunk;});request.on("end",async()=>{stats.received+=1;try{const canonicalBody=JSON.stringify(JSON.parse(body));const status=await deliver(canonicalBody);response.writeHead(202,{"content-type":"application/json"});response.end(JSON.stringify({accepted:true,receiverStatus:status}));}catch(error){response.writeHead(502,{"content-type":"application/json"});response.end(JSON.stringify({accepted:false,message:String(error.message).slice(0,200)}));}});
}).listen(port,"0.0.0.0");
