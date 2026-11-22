/**
 * THE COMMAND CENTER IN THE PLATFORM'S MATERIALS (owner 11-20 brief §11: "replacing its older cyan/gold terminal
 * treatment with the shared smoked-graphite materials, silver typography, restrained AI accent").
 *
 * Every classic colour in the Command Center is written as var(--cc-<its own hex>, <itself>), so a member, for
 * whom none of these is defined, sees exactly the classic colours. The redesign preview (an admin with the new
 * shell switched on) gets this block on <html>: graphite for the navy surfaces, silver for gold, the AI accent for
 * cyan, mint and rose for direction. The entrance sequence and the canvas drawings are not part of it.
 * Generated from the table in the codemod that wrote the variables; one line a classic colour.
 */
export const CC_NEXT_CSS = `html.om-cc-next {
  --cc-03070b: #08090b; --cc-03070b-rgb: 8,9,11;
  --cc-050b11: #101114; --cc-050b11-rgb: 16,17,20;
  --cc-071019: #111317; --cc-071019-rgb: 17,19,23;
  --cc-07101a: #131518; --cc-07101a-rgb: 19,21,24;
  --cc-09131d: #17191e; --cc-09131d-rgb: 23,25,30;
  --cc-0c1721: #1b1d22; --cc-0c1721-rgb: 27,29,34;
  --cc-06090e: #08090b; --cc-06090e-rgb: 8,9,11;
  --cc-0a0e15: #131518; --cc-0a0e15-rgb: 19,21,24;
  --cc-0b1017: #131518; --cc-0b1017-rgb: 19,21,24;
  --cc-0e131c: #1b1d22; --cc-0e131c-rgb: 27,29,34;
  --cc-04080c: #08090b; --cc-04080c-rgb: 8,9,11;
  --cc-03080e: #08090b; --cc-03080e-rgb: 8,9,11;
  --cc-15345c: #2b2e36; --cc-15345c-rgb: 43,46,54;
  --cc-d5a93d: #D9DDE6; --cc-d5a93d-rgb: 217,221,230;
  --cc-e7c467: #EEF0F5; --cc-e7c467-rgb: 238,240,245;
  --cc-ffd875: #FFFFFF; --cc-ffd875-rgb: 255,255,255;
  --cc-f0c475: #EEF0F5; --cc-f0c475-rgb: 238,240,245;
  --cc-e9b949: #D9DDE6; --cc-e9b949-rgb: 217,221,230;
  --cc-fff3d0: #FFFFFF; --cc-fff3d0-rgb: 255,255,255;
  --cc-8a5f12: #6B7080; --cc-8a5f12-rgb: 107,112,128;
  --cc-1a1305: #101116; --cc-1a1305-rgb: 16,17,22;
  --cc-ffc85a: #EEF0F5; --cc-ffc85a-rgb: 238,240,245;
  --cc-00c7e8: #C5B9ED; --cc-00c7e8-rgb: 197,185,237;
  --cc-27d7f2: #D2C8F0; --cc-27d7f2-rgb: 210,200,240;
  --cc-6fa8dc: #C5B9ED; --cc-6fa8dc-rgb: 197,185,237;
  --cc-59afff: #C8D0E4; --cc-59afff-rgb: 200,208,228;
  --cc-78ebff: #D6DEFF; --cc-78ebff-rgb: 214,222,255;
  --cc-29dfa6: #8BC5B0; --cc-29dfa6-rgb: 139,197,176;
  --cc-3fd9a0: #8BC5B0; --cc-3fd9a0-rgb: 139,197,176;
  --cc-2bd48f: #8BC5B0; --cc-2bd48f-rgb: 139,197,176;
  --cc-ff5364: #D59CAA; --cc-ff5364-rgb: 213,156,170;
  --cc-f4737b: #D59CAA; --cc-f4737b-rgb: 213,156,170;
  --cc-f0f4f7: #F4F5F7; --cc-f0f4f7-rgb: 244,245,247;
  --cc-e8eff7: #F4F5F7; --cc-e8eff7-rgb: 244,245,247;
  --cc-81909e: #A9AFBB; --cc-81909e-rgb: 169,175,187;
  --cc-596773: #7D8391; --cc-596773-rgb: 125,131,145;
  --cc-dce6ee: #E6E8EE; --cc-dce6ee-rgb: 230,232,238;
}
html.om-fullscreen.om-cc-next, html.om-fullscreen.om-cc-next body { background: #08090b !important; }
`;
