// ohvStateExtraLinks.ts
// Verified SUPPLEMENTAL OHV resource links per state, rendered in addition to the
// single official authority in ohvStateResources.ts. Each link individually
// search-verified against an official source; non-commercial only (state/federal
// agency, official tourism, public recreation authority, or genuine nonprofit
// rider association). No fabricated URLs.
//
// kind:
//   'official-directory' = agency "find a club / where to ride" page
//   'association'        = statewide nonprofit OHV/ATV rider association
//   'where-to-ride'      = official page listing actual riding areas
//   'rules-authority'    = the governing agency's rules/registration page
//                          (used for states with no public OHV trails)
//
// note: optional honest-context string shown above the link(s) on the card.

export interface OhvStateExtraLink {
  name: string;
  url: string;
  kind: 'official-directory' | 'association' | 'where-to-ride' | 'rules-authority';
}

export interface OhvStateExtra {
  links: OhvStateExtraLink[];
  note?: string;
}

export const OHV_STATE_EXTRA_LINKS: Record<string, OhvStateExtra> = {
  AZ: { links: [
    { name: 'Arizona State Parks — Join an OHV Club', url: 'https://azstateparks.com/join-an-ohv-club', kind: 'official-directory' },
  ]},
  CA: { links: [
    { name: 'California Off-Road Vehicle Association (CORVA)', url: 'https://corva.org/', kind: 'association' },
    { name: 'California Outdoor Recreation Foundation', url: 'https://outdoorrecreationfoundation.org/', kind: 'association' },
  ]},
  CO: { links: [
    { name: 'Colorado Off-Highway Vehicle Coalition (COHVCO)', url: 'https://cohvco.clubexpress.com/', kind: 'association' },
  ]},
  ID: { links: [
    { name: 'Idaho State ATV/UTV Association (ISATVA)', url: 'https://idahostateatv.org/', kind: 'association' },
  ]},
  IA: { links: [
    { name: 'Iowa Off-Highway Vehicle Association', url: 'https://iowaohv.org/', kind: 'association' },
  ]},
  MI: { links: [
    { name: 'Michigan ORV/ATV Riding (Pure Michigan)', url: 'https://www.michigan.org/orv-atv-riding', kind: 'where-to-ride' },
  ]},
  MN: { links: [
    { name: 'All-Terrain Vehicle Association of Minnesota (ATV MN)', url: 'https://atvmn.org/', kind: 'association' },
  ]},
  MT: { links: [
    { name: 'Montana Trail Vehicle Riders Association (MTVRA)', url: 'https://mtvra.com/', kind: 'association' },
  ]},
  ND: { links: [
    { name: 'ND Parks & Rec — OHV Trails', url: 'https://www.parkrec.nd.gov/business/recreation-programs/highway-vehicles-ohv/ohv-trails', kind: 'where-to-ride' },
  ]},
  NM: { links: [
    { name: 'New Mexico Off-Highway Vehicle Alliance (NMOHVA)', url: 'https://www.nmohva.org/', kind: 'association' },
    { name: 'Ride New Mexico — Where to Ride', url: 'https://ridenm.dgf.nm.gov/ride/', kind: 'where-to-ride' },
  ]},
  NV: { links: [
    { name: 'Nevada Offroad Association (NVORA)', url: 'https://www.nevadaoffroad.us/', kind: 'association' },
    { name: 'Nevada Trail Finder (official)', url: 'https://www.nvtrailfinder.com/trails', kind: 'where-to-ride' },
  ]},
  OR: { links: [
    { name: 'Oregon State Parks — ATV Clubs & Volunteering', url: 'https://www.oregon.gov/oprd/atv/pages/atv-volunteer-land-use.aspx', kind: 'official-directory' },
    { name: 'Oregon Motorcycle Riders Association (OMRA)', url: 'https://www.omraoffroad.com/', kind: 'association' },
  ]},
  UT: { links: [
    { name: 'Utah ATV Association', url: 'https://utahatv.com/', kind: 'association' },
    { name: 'Utah OHV Program — Clubs & Organizations', url: 'https://recreation.utah.gov/local-ohv-clubs-organizations/', kind: 'official-directory' },
  ]},
  WA: { links: [
    { name: 'Washington Off Highway Vehicle Alliance (WOHVA)', url: 'https://www.wohva.org/', kind: 'association' },
  ]},
  WY: { links: [
    { name: 'Wyoming State Parks — ORV Clubs', url: 'https://wyoparks.wyo.gov/index.php/orv-trails/orv-clubs-trails', kind: 'official-directory' },
  ]},
  WI: { links: [
    { name: 'Wisconsin ATV/UTV Association (WATVA)', url: 'https://www.watva.org/', kind: 'association' },
  ]},
  NE: { links: [
    { name: 'Nebraska Game & Parks — Explore Trails', url: 'https://outdoornebraska.gov/parks/explore-trails/', kind: 'where-to-ride' },
    { name: 'Nebraska National Forest — Off-Highway Vehicles', url: 'https://www.fs.usda.gov/r02/nebraska/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  SD: { links: [
    { name: 'SD Game, Fish & Parks — ATVs & Off-Highway Vehicles', url: 'https://gfp.sd.gov/atv/', kind: 'where-to-ride' },
  ]},
  IL: { links: [
    { name: 'Illinois DNR — Off-Road Trails', url: 'https://dnr.illinois.gov/parks/offroad.html', kind: 'where-to-ride' },
  ]},
  IN: { links: [
    { name: 'Indiana DNR — Motorized Recreation', url: 'https://www.in.gov/dnr/state-parks/recreation/motorized-recreation/', kind: 'where-to-ride' },
    { name: 'Indiana DNR — Clubs & Organizations', url: 'https://in.gov/dnr/state-parks/recreation/trails/off-roading', kind: 'official-directory' },
  ]},
  OH: { links: [
    { name: 'Ohio DNR — APV Riding', url: 'https://ohiodnr.gov/go-and-do/find-a-trail/apv-riding', kind: 'where-to-ride' },
  ]},
  MO: { links: [
    { name: 'Missouri State Parks — ORV Riding', url: 'https://mostateparks.com/activity/all_terrain_vehicle_riding', kind: 'where-to-ride' },
  ]},
  OK: { links: [
    { name: 'TravelOK — ATV & ORV Recreation', url: 'https://www.travelok.com/atv_and_orv', kind: 'where-to-ride' },
  ]},
  TX: { links: [
    { name: 'Texas Parks & Wildlife — OHV Program', url: 'https://tpwd.texas.gov/state-parks/texas-off-highway-program', kind: 'where-to-ride' },
    { name: 'Texas Motorized Trails Coalition (TMTC)', url: 'https://tpwd.texas.gov/state-parks/texas-off-highway-program/ohv-other-resources', kind: 'association' },
  ]},
  AR: { links: [
    { name: 'Arkansas.com — Off-Roading & ATV', url: 'https://www.arkansas.com/experiences/discover/all-experiences/off-roading-atv', kind: 'where-to-ride' },
  ]},
  LA: { links: [
    { name: 'Kisatchie National Forest — OHV', url: 'https://www.fs.usda.gov/r08/kisatchie/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  MS: { links: [
    { name: 'MS Dept. of Wildlife, Fisheries & Parks — Recreational Trails', url: 'https://www.mdwfp.com/parks-destinations/recreational-trails', kind: 'where-to-ride' },
  ]},
  AL: { links: [
    { name: 'Alabama State Parks — OHV Trail (Bucks Pocket)', url: 'https://www.alapark.com/parks/bucks-pocket-state-park/ohv-trail', kind: 'where-to-ride' },
  ]},
  GA: { links: [
    { name: 'Chattahoochee-Oconee National Forest — OHV', url: 'https://www.fs.usda.gov/r08/chattahoochee-oconee/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  FL: { links: [
    { name: 'USFS National Forests in Florida — OHV (Ocala NF)', url: 'https://www.fs.usda.gov/r08/florida/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  TN: { links: [
    { name: 'TWRA — North Cumberland WMA (OHV)', url: 'https://www.tn.gov/twra/wildlife-management-areas/east-tennessee-r4/north-cumberland-wma.html', kind: 'where-to-ride' },
  ]},
  KY: { links: [
    { name: 'Kentucky Tourism — Off-Roading', url: 'https://www.kentuckytourism.com/things-to-do/outdoors/outdoor-recreation/off-roading', kind: 'where-to-ride' },
  ]},
  NC: { links: [
    { name: 'National Forests in NC — OHV', url: 'https://www.fs.usda.gov/r08/northcarolina/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  SC: { links: [
    { name: 'Francis Marion & Sumter National Forests — OHV', url: 'https://www.fs.usda.gov/r08/francismarionsumter/recreation/opportunities/highway-vehicles-ohv', kind: 'where-to-ride' },
  ]},
  VA: { links: [
    { name: 'Spearhead Trails (SRRA)', url: 'https://www.spearheadtrails.com/', kind: 'where-to-ride' },
    { name: 'Virginia.org — ATV & Spearhead Trails', url: 'https://www.virginia.org/things-to-do/sports-and-recreation/atv-and-spearhead-trails/', kind: 'official-directory' },
  ]},
  WV: { links: [
    { name: 'Hatfield-McCoy Trails', url: 'https://trailsheaven.com/', kind: 'where-to-ride' },
  ]},
  MD: { links: [
    { name: 'Maryland DNR — Off-Road Vehicles on State Forests', url: 'https://dnr.maryland.gov/forests/pages/orv/trails.aspx', kind: 'where-to-ride' },
  ]},
  PA: { links: [
    { name: 'PA DCNR — ATV Trails in State Forests', url: 'https://www.pa.gov/agencies/dcnr/recreation/what-to-do/atv-riding/atv-trails-in-state-forests', kind: 'where-to-ride' },
  ]},
  NY: { links: [
    { name: 'St. Lawrence County ATV Trail System', url: 'https://www.visitstlc.com/atv-ride/', kind: 'where-to-ride' },
  ], note: 'New York limits ATV use on most state land; the largest public riding is county-run trail systems like this one. Elsewhere, ride only with landowner permission.' },
  MA: { links: [
    { name: 'Mass.gov — Find a State Park OHV Riding Trail', url: 'https://www.mass.gov/info-details/find-a-state-park-ohv-riding-trail', kind: 'where-to-ride' },
  ]},
  VT: { links: [
    { name: 'Vermont ATV Sportsman’s Association (VASA)', url: 'https://www.vtvasa.org/', kind: 'association' },
    { name: 'VT Forests, Parks & Recreation — All-Terrain Vehicles', url: 'https://fpr.vermont.gov/recreation/activities/all-terrain-vehicles', kind: 'official-directory' },
  ]},
  NH: { links: [
    { name: 'NH Off-Highway Vehicle Association (NHOHVA)', url: 'https://nhohva.org/', kind: 'association' },
    { name: 'NH Fish & Game — Where to Ride OHRVs', url: 'https://www.wildlife.nh.gov/highway-recreational-vehicles-ohrv-and-snowmobiles/where-ride-ohrvs-and-snowmobiles-new-hampshire', kind: 'where-to-ride' },
  ]},
  ME: { links: [
    { name: 'ATV Maine', url: 'https://www.atvmaine.org/', kind: 'association' },
    { name: 'Maine Bureau of Parks & Lands — ATV Trails', url: 'https://www.maine.gov/dacf/parks/trail_activities/atv/atv-trails.shtml', kind: 'where-to-ride' },
  ]},
  HI: { links: [
    { name: 'Hawaii DLNR — Off-Highway Vehicles (OHV)', url: 'https://dlnr.hawaii.gov/recreation/nah/off-highway-vehicles-ohv/', kind: 'where-to-ride' },
  ]},
  DE: { links: [
    { name: 'Delaware DMV — Off-Highway Vehicles', url: 'https://dmv.de.gov/VehicleServices/specialvehicles/index.shtml?dc=ve_reg_ohv', kind: 'rules-authority' },
  ], note: 'Delaware has no public OHV trails. Riding is allowed only on private property with the owner’s permission. See the state authority below for rules.' },
  NJ: { links: [
    { name: 'NJ DEP — Division of Parks & Forestry', url: 'https://dep.nj.gov/parksandforests/', kind: 'rules-authority' },
  ], note: 'New Jersey has no public state-land OHV trails. Riding is limited to private parks and private property with permission. See the state authority below for rules.' },
  CT: { links: [
    { name: 'CT DEEP — Off-Road Vehicles in State Parks & Forests', url: 'https://portal.ct.gov/DEEP/State-Parks/Recreation-Information/Off-Road-Vehicles---CT-State-Parks-and-Forests', kind: 'rules-authority' },
  ], note: 'Connecticut has no public areas open to ATVs; riding ATVs on state or municipal land can be charged as criminal trespass. See the state authority below before riding.' },
  RI: { links: [
    { name: 'Rhode Island DEM', url: 'https://dem.ri.gov/', kind: 'rules-authority' },
  ], note: 'Rhode Island has no designated public ATV trails and ATVs cannot be street-registered. Riding is allowed only on private property with permission. See the state authority below for rules.' },
};
