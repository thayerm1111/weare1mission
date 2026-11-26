import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketStory, storyDirection } from "../src/components/om/simple/MarketStory";
import { genxMarketStory } from "../src/components/om/genx/SimpleGenxRead";
import { priceRuns, SimpleChartPlot } from "../src/components/om/chart/SimpleChartPlot";
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
  const current = genxMarketStory(props);
  assert.equal(current.watchPrice, 2051);
  const neutral = genxMarketStory({...props,bias:"neutral"});
  assert.equal(neutral.direction, "up");
  assert.equal(neutral.lean, false);
  const differentLean = genxMarketStory({...props,bias:"bearish"});
  assert.equal(differentLean.direction, "down");
  assert.equal(differentLean.lean, true);
  const shown = draw(current);
  assert.match(shown,/data-feed="current"/);
  assert.match(shown,/See how price reacts near 2,051.00/);
  assert.doesNotMatch(shown,/Review the entry/);
  const later = now+5*tfMs;
  const delayed = genxMarketStory({...props,now:later,asOf:new Date(later).toISOString()});
  assert.equal(delayed.watchPrice, null);
  const old = draw(delayed);
  assert.match(old,/Update delayed/);
  assert.doesNotMatch(old,/2,051.00/);
});

test("the simple chart uses only observed closes and breaks the line for gaps and closures", () => {
  const bars = [0,1,2,7,8,9].map((t,i) => ({t:t*60_000,o:90+i,h:190+i,l:80-i,c:100+i}));
  const closed = new Set([60_000]);
  assert.deepEqual(priceRuns(bars,0,5,60_000,true,closed),[[0],[2],[3,4,5]]);
  const props = {bars,first:0,last:5,left:0,right:5,x:(i:number)=>i*20,y:(price:number)=>230-price,
    width:130,height:150,header:30,uid:"test",tfMs:60_000,timeKnown:true,closed,selected:-1,watch:120,markStart:0,decimals:2};
  const html = renderToStaticMarkup(React.createElement(SimpleChartPlot,props));
  assert.match(html,/d="M60.00 127.00 L80.00 126.00 L100.00 125.00"/);
  assert.match(html,/Watch level 120.00/);
  assert.equal(html.match(/class="om-ch-line-watch"/g)?.length,1);
  const farWatch = renderToStaticMarkup(React.createElement(SimpleChartPlot,{...props,watch:300}));
  assert.match(farWatch,/Watch higher/);
  assert.doesNotMatch(farWatch,/stroke-dasharray="4 5"/);
  const unknownTimes = renderToStaticMarkup(React.createElement(SimpleChartPlot,{...props,timeKnown:false,watch:null}));
  assert.doesNotMatch(unknownTimes,/om-ch-line-time|om-ch-line-watch/);
});
