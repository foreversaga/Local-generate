"use client";
import { useEffect, useState } from "react";
import styles from "./ServiceStatusLink.module.css";
import { useI18n } from "../../i18n/I18nProvider";

type Health={runtime?:{mode?:string};comfy?:{online?:boolean;remote?:boolean};ollama?:{online?:boolean};codex?:{online?:boolean}};
export function ServiceStatusLink(){const {t}=useI18n();const [health,setHealth]=useState<Health|null>(null);useEffect(()=>{let active=true;const refresh=async()=>{try{const response=await fetch("/app/api/health");if(!response.ok)throw new Error();const next=await response.json() as Health;if(active)setHealth(next)}catch{if(active)setHealth(null)}};void refresh();const timer=window.setInterval(refresh,10000);return()=>{active=false;window.clearInterval(timer)}},[]);const mode=health?.runtime?.mode||(health?.comfy?.remote?"remote":"local");const online=Boolean(health?.comfy?.online);const runtime=t(mode==="remote"?"service.remote":"service.local");const status=t(online?"service.connected":"service.disconnected");return <a className={styles.link} href="/app/settings" aria-label={t("service.runtime",{runtime,status})}><span className={`${styles.dot} ${online?styles.online:""}`} aria-hidden="true"/><span>{runtime}</span></a>}
