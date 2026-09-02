import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "../api/client";
import { moneyCfg } from "./format";

type MoneyContextValue = {
  config: typeof moneyCfg;
  refresh: () => Promise<void>;
};

const MoneyContext = createContext<MoneyContextValue | null>(null);

export function useMoney(): MoneyContextValue {
  const value = useContext(MoneyContext);
  if (!value) throw new Error("useMoney must be used inside MoneyProvider");
  return value;
}

export function MoneyProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState({ ...moneyCfg });
  const refresh = useCallback(async () => {
    try {
      const cfg = await api.get("/lists/money-config");
      moneyCfg.code = cfg.code ?? moneyCfg.code;
      moneyCfg.symbol = cfg.symbol ?? moneyCfg.symbol;
      moneyCfg.locale = cfg.locale ?? moneyCfg.locale;
      if (Array.isArray(cfg.denominations) && cfg.denominations.length)
        moneyCfg.denominations = cfg.denominations;
      moneyCfg.timezone = cfg.timezone ?? moneyCfg.timezone;
      moneyCfg.restaurant_name = cfg.restaurant_name ?? moneyCfg.restaurant_name;
      document.title = `${cfg.restaurant_name ?? "Ledger"} · Counter Book`;
      setConfig({ ...moneyCfg });
    } catch (error) {
      console.warn("Using default money configuration", error);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <MoneyContext.Provider value={{ config, refresh }}>
      {children}
    </MoneyContext.Provider>
  );
}
