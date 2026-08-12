"use client";
import { useEffect, useState } from "react";
import styles from "./ServiceStatusLink.module.css";

type Health={runtime?:{mode?:string};comfy?:{online?:boolean;remote?:boolean};ollama?:{online?:boolean};codex?:{online?:boolean}};
export function ServiceStatusLink(){const [health,setHealth]=useState<Health|null>(null);useEffect(()=>{let active=true;const refresh=async()=>{try{const response=await fetch("/app/api/health");if(!response.ok)throw new Error();const next=await response.json() as Health;if(active)setHealth(next)}catch{if(active)setHealth(null)}};void refresh();const timer=window.setInterval(refresh,10000);return()=>{active=false;window.clearInterval(timer)}},[]);const mode=health?.runtime?.mode||(health?.comfy?.remote?"remote":"local");const online=Boolean(health?.comfy?.online);return <a className={styles.link} href="/app/settings" aria-label={`執行環境 ${mode==="remote"?"Vast 遠端":"本機"}，ComfyUI ${online?"已連線":"未連線"}`}><span className={`${styles.dot} ${online?styles.online:""}`} aria-hidden="true"/><span>{mode==="remote"?"Vast 遠端":"本機"}</span></a>}
