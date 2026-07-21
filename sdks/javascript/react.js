"use strict";

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
  return { Context,GoodbaseProvider,useGoodbase,useGoodbaseSession };
}

module.exports = { createGoodbaseReactBindings };
