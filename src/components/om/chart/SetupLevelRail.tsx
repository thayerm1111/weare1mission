import { railName, railRows } from "@/lib/chart/setupFraming";
import { priceText, type ChartLevel } from "@/lib/floor/chart";

export function SetupLevelRail({ levels, x, top, bottom, width, dec, colors }: {
  levels: { l: ChartLevel; ly: number }[]; x: number; top: number; bottom: number; width: number; dec: number;
  colors: Record<ChartLevel["kind"], string>;
}) {
  return <g className="om-ch-rail" data-no-i18n>
    {railRows(levels, top+10, bottom-15).map(({ items, y }) => {
      const { l } = items[0], tone = colors[l.kind];
      const name = items.length > 1 ? `${items.length} levels` : railName(l, width < 100);
      const formatted = priceText(l.price, dec);
      const price = items.length > 1 ? `${formatted}…` : formatted;
      const full = items.map(({l}) => l.label+" "+priceText(l.price,dec)).join(" · ");
      return <g key={items.map(({l}) => l.label+l.price).join("/")} data-price-level={l.kind} role="img" aria-label={full}>
        <title>{full}</title>
        {items.map(({ l: level, ly: py },i) => <path key={i} d={`M${x},${py} h3 L${x+8},${y} h3`}
          fill="none" style={{stroke:colors[level.kind]}} strokeWidth=".85" opacity=".8"/>)}
        <text x={x+14} y={y-2} className="om-ch-rail-name" style={{fill:tone}} textLength={name.length*5.9>width-17 ? width-17 : undefined} lengthAdjust="spacingAndGlyphs">{name}</text>
        <text x={x+14} y={y+11} className="om-ch-rail-price" textLength={price.length*7>width-17?width-17:undefined} lengthAdjust="spacingAndGlyphs">{price}</text>
      </g>;
    })}
  </g>;
}
