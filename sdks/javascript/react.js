"use strict";

const { GoodbaseTelemetry } = require("./telemetry");

function createGoodbaseReactBindings(React, client) {
  const Context = React.createContext(client);
  function GoodbaseProvider(props) {
    return React.createElement(Context.Provider, { value: props.client || client }, props.children);
  }
  function useGoodbase() {
    const value = React.useContext(Context);
    if (!value) throw new Error("GoodbaseProvider is missing.");
    return value;
  }
  function useGoodbaseSession() {
    const api = useGoodbase();
    const [state, setState] = React.useState({ loading:true,session:null,error:null });
    React.useEffect(function () {
      let active = true;
      api.request("/api/auth/session").then(function (session) {
        if (active) setState({loading:false,session:session,error:null});
      }).catch(function (error) {
        if (active) setState({loading:false,session:null,error:error});
      });
      return function () { active = false; };
    }, [api]);
    return state;
  }
  function useGoodbaseTelemetry(options) {
    const api=useGoodbase(),reference=React.useRef(null);
    React.useEffect(function(){
      const telemetry=new GoodbaseTelemetry({...options,client:api});reference.current=telemetry;telemetry.start();
      return function(){telemetry.stop();reference.current=null;};
    },[api,options.appId,options.release,options.buildNumber]);
    return reference;
  }
  return { Context,GoodbaseProvider,useGoodbase,useGoodbaseSession,useGoodbaseTelemetry };
}

module.exports = { createGoodbaseReactBindings };
