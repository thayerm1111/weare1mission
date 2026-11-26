import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketStory, storyDirection } from "../src/components/om/simple/MarketStory";
import { SimpleGenxRead } from "../src/components/om/genx/SimpleGenxRead";
import { HomeApps } from "../src/components/om/floor/HomeApps";

(globalThis as unknown as { React: typeof React }).React = React;
const draw = (props: Partial<React.ComponentProps<typeof MarketStory>> = {}) => renderToStaticMarkup(
  React.createElement(MarketStory, { market: "Gold", direction: "up", stage: "forming", next: "Watch the last high.", ...props })
);
test("one accessible stage describes a current setup and a recorded read is dated separately", () => {
  const current = draw();
  assert.equal(current.match(/aria-current="step"/g)?.length, 1);
  assert.match(current, /Rising/);
  assert.match(current, /Watch the last high/);
  const saved = draw({feed:"recorded", direction:storyDirection("bearish"), lean:true, stamp:"At analysis"});
  assert.match(saved, /Leans down/);
  assert.match(saved, /At analysis/);
  assert.match(saved, /Setup at the time/);
  assert.match(draw({direction:storyDirection("range")}), /Sideways/);
  assert.match(draw({direction:storyDirection("unknown")}), /No clear direction/);
});
test("an unusable feed clears the direction, the active step and the actionable watch", () => {
  for (const feed of ["closed","delayed","loading","unavailable"] as const) {
    const html = draw({feed});
    assert.match(html, /data-direction="unclear"/);
    assert.doesNotMatch(html, /aria-current="step"|Rising|Watch the last high/);
  }
});
test("active trades and finished plans are distinct from finding a new entry", () => {
  assert.match(draw({stage:"inTrade"}), /In a trade/);
  const closed = draw({feed:"recorded", stage:"finished", next:"This plan reached its stop."});
  assert.match(closed, /Plan finished/);
  assert.doesNotMatch(closed, /aria-current="step"/);
});
test("the Home launcher offers all eight tools and opens the currency setup finder directly", () => {
  const html = renderToStaticMarkup(React.createElement(HomeApps));
  assert.equal(html.match(/<a /g)?.length, 8);
  for (const name of ["Atlas","GenX","GenX FX","Strata","OM AI Plays","Pulse","Flow","Nitrous"]) assert.ok(html.includes(">"+name+"<"),name);
  assert.match(html,/href="\/portal\/genx\?market=fx"/);
});

test("GenX can show one real candle level without publishing an entry or reviving old candles", () => {
  const now = Date.UTC(2026,10,25,16);
  const tfMs = 300_000;
  const bars = Array.from({length:50},(_,i)=>({t:now-(50-i)*tfMs,o:2000+i,h:2002+i,l:1999+i,c:2001+i}));
  const props = {market:"Gold",dec:2,snapshot:false,closed:false,failed:false,loaded:true,bars,tfMs,timeKnown:true,asOf:new Date(now).toISOString(),now};
  const shown = renderToStaticMarkup(React.createElement(SimpleGenxRead,props));
  assert.match(shown,/data-feed="current"/);
  assert.match(shown,/See how price reacts near 2,051.00/);
  assert.doesNotMatch(shown,/Review the entry/);
  const later = now+5*tfMs;
  const old = renderToStaticMarkup(React.createElement(SimpleGenxRead,{...props,now:later,asOf:new Date(later).toISOString()}));
  assert.match(old,/Update delayed/);
  assert.doesNotMatch(old,/2,051.00/);
});
