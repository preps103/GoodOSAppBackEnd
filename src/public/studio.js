(function(){"use strict";
  const panels=document.getElementById("panels"),error=document.getElementById("error"),overall=document.getElementById("overall");
  function token(){for(const key of ["goodos_access_token","goodbase_access_token","access_token","token"]){const value=localStorage.getItem(key)||sessionStorage.getItem(key);if(value&&value.split(".").length===3)return value;}return "";}
  async function request(path){const headers={Accept:"application/json"},value=token();if(value)headers.Authorization=`Bearer ${value}`;const response=await fetch(path,{headers,credentials:"same-origin",cache:"no-store"});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.message||`Request failed (${response.status})`);return body;}
  function card(title,description,value,ready){return `<article class="card"><span class="badge ${ready?"ready":"blocked"}">${ready?"verified":"unconfigured"}</span><h2>${title}</h2><p>${description}</p><div class="metric">${value}</div></article>`;}
  async function load(){error.hidden=true;overall.textContent="Checking production…";try{const data=await request("/api/goodbase/v1/experience/studio/overview"),m=data.metrics,r=data.readiness;panels.innerHTML=[
    card("App distribution","Verified stores or device labs with passing real-device evidence.",`${m.ready_distribution_providers} providers`,r.distribution),
    card("Device testing","Completed test matrices backed by provider artifacts.",`${m.passed_device_tests} passed`,r.distribution),
    card("Analytics","Consent-aware production events received by Goodbase.",`${m.analytics_events} events`,r.telemetry),
    card("Crashes","Open or regressed crash groups requiring attention.",`${m.open_crashes} open`,m.open_crashes===0&&r.telemetry),
    card("Performance","Startup, screen, network, ANR, and custom traces.",`${m.performance_traces} traces`,m.performance_traces>0),
    card("In-app messaging","Approved campaigns currently active.",`${m.active_in_app_campaigns} active`,r.personalization),
    card("Application hosting","Projects connected to a verified hosting controller.",`${m.ready_hosting_projects} ready`,r.hosting),
    card("Controllers","Healthy external control-plane integrations.",`${m.ready_controllers} ready`,m.ready_controllers>0)
  ].join("");const verified=Object.values(r).filter(Boolean).length;overall.textContent=`${verified} of ${Object.keys(r).length} platform families verified`;}catch(cause){error.textContent=cause.message;error.hidden=false;overall.textContent="Evidence unavailable";panels.innerHTML="";}}
  document.getElementById("refresh").addEventListener("click",load);load();
})();
