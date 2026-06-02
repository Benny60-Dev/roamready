// ohvStateResources.ts
// Verified OHV resource directory for RoamReady.ai
// Each state link was individually checked against a current official source (May 2026).
//
// `type` field meaning:
//   'state-program'  = a dedicated state OHV/ORV recreation program page (where-to-ride focus)
//   'state-portal'   = official state tourism / trails portal covering OHV
//   'usfs'           = the real public-land OHV authority is the US Forest Service (no separate state program)
//   'authority'      = a state-created public recreation authority that runs the trail system
//   'registration'   = official state page is registration/regulatory (DMV/agency); limited public riding
//
// `confidence`: 'high' = canonical official OHV authority; 'medium' = best-available official/limited.
// NOTE: state agency sites get reorganized — pair this file with a monthly automated link-check (see LAUNCH_STATUS backlog).

export interface OhvResourceLink {
  name: string;
  description: string;
  url: string;
}

export interface OhvStateResource {
  state: string;        // full state name
  abbr: string;         // 2-letter
  agency: string;       // the authority the link points to
  url: string;
  type: 'state-program' | 'state-portal' | 'usfs' | 'authority' | 'registration';
  confidence: 'high' | 'medium';
}

// ---- Always-shown national links (serve every rider, anywhere, incl. Moab/Del Rio federal land) ----
export const OHV_NATIONAL_LINKS: OhvResourceLink[] = [
  {
    name: 'Recreation.gov',
    description: 'Reserve federal campgrounds & OHV permits nationwide',
    url: 'https://www.recreation.gov',
  },
  {
    name: 'USFS Motor Vehicle Use Maps',
    description: 'Where you can legally ride on national forest land',
    url: 'https://www.fs.usda.gov/visit/know-before-you-go/motor-vehicle-use-maps',
  },
  {
    name: 'BLM Off-Highway Vehicle',
    description: 'Riding areas on public lands across the West',
    url: 'https://www.blm.gov/programs/recreation/ohv',
  },
  {
    name: 'Tread Lightly!',
    description: 'Responsible riding & land-use education',
    url: 'https://www.treadlightly.org',
  },
];

// ---- Honest disclaimer to render with the block ----
export const OHV_RESOURCE_DISCLAIMER =
  "These are official state and federal resources, provided for convenience. " +
  "Agencies occasionally reorganize their sites — if a link doesn't work, search the agency name, or let us know and we'll fix it.";

// ---- Verified per-state OHV authorities (all 50) ----
export const OHV_STATE_RESOURCES: OhvStateResource[] = [
  { state: 'Alabama', abbr: 'AL', agency: 'Alabama Recreation Trails (OHV)', url: 'https://alabamarecreationtrails.org/activity/ohv-jeeps/', type: 'state-portal', confidence: 'medium' },
  { state: 'Alaska', abbr: 'AK', agency: 'BLM Alaska — Off-Highway Vehicles', url: 'https://www.blm.gov/programs/recreation/recreation-activities/alaska', type: 'state-portal', confidence: 'high' },
  { state: 'Arizona', abbr: 'AZ', agency: 'Arizona State Parks OHV Program', url: 'https://azstateparks.com/ohv', type: 'state-program', confidence: 'high' },
  { state: 'Arkansas', abbr: 'AR', agency: 'Arkansas Tourism — Off-Roading & ATV', url: 'https://www.arkansas.com/experiences/discover/all-experiences/off-roading-atv', type: 'state-portal', confidence: 'medium' },
  { state: 'California', abbr: 'CA', agency: 'California State Parks OHMVR Division', url: 'https://ohv.parks.ca.gov', type: 'state-program', confidence: 'high' },
  { state: 'Colorado', abbr: 'CO', agency: 'Colorado Parks & Wildlife — OHV', url: 'https://cpw.state.co.us/activities/off-highway-vehicles-and-snowmobiles', type: 'state-program', confidence: 'high' },
  { state: 'Connecticut', abbr: 'CT', agency: 'CT DEEP — Off-Road Vehicles', url: 'https://portal.ct.gov/DEEP/State-Parks/Recreation-Information/Off-Road-Vehicles---CT-State-Parks-and-Forests', type: 'state-program', confidence: 'medium' },
  { state: 'Delaware', abbr: 'DE', agency: 'Delaware DNREC — Parks & Recreation', url: 'https://dnrec.delaware.gov/parks/', type: 'state-program', confidence: 'medium' },
  { state: 'Florida', abbr: 'FL', agency: 'Florida Forest Service — OHV Riding', url: 'https://www.fdacs.gov/Forest-Wildfire/Our-Forests/State-Forests/Recreation/Off-Highway-Vehicle-Riding', type: 'state-program', confidence: 'medium' },
  { state: 'Georgia', abbr: 'GA', agency: 'USFS Chattahoochee-Oconee NF — OHV', url: 'https://www.fs.usda.gov/r08/chattahoochee-oconee/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'medium' },
  { state: 'Hawaii', abbr: 'HI', agency: 'Hawaii DLNR — Nā Ala Hele OHV', url: 'https://dlnr.hawaii.gov/recreation/nah/off-highway-vehicles-ohv/', type: 'state-program', confidence: 'high' },
  { state: 'Idaho', abbr: 'ID', agency: 'Idaho Parks & Recreation — OHV', url: 'https://parksandrecreation.idaho.gov/park-activity/atvs-utvs-motorbikes/', type: 'state-program', confidence: 'high' },
  { state: 'Illinois', abbr: 'IL', agency: 'Illinois DNR — Offroad Trails', url: 'https://dnr.illinois.gov/parks/offroad.html', type: 'state-program', confidence: 'high' },
  { state: 'Indiana', abbr: 'IN', agency: 'Indiana DNR — Motorized Recreation', url: 'https://www.in.gov/dnr/state-parks/recreation/motorized-recreation/', type: 'state-program', confidence: 'high' },
  { state: 'Iowa', abbr: 'IA', agency: 'Iowa DNR — Off-Highway Vehicles', url: 'https://www.iowadnr.gov/things-do/highway-vehicles', type: 'state-program', confidence: 'high' },
  { state: 'Kansas', abbr: 'KS', agency: 'Kansas Tourism — Off-Roading & ORV Trails', url: 'https://www.travelks.com/blog/stories/post/kansas-off-roading-jeep-and-orv-trails/', type: 'state-program', confidence: 'medium' },
  { state: 'Kentucky', abbr: 'KY', agency: 'Kentucky Tourism — Off-Roading', url: 'https://www.kentuckytourism.com/things-to-do/outdoors/outdoor-recreation/off-roading', type: 'state-portal', confidence: 'medium' },
  { state: 'Louisiana', abbr: 'LA', agency: 'USFS Kisatchie National Forest — OHV', url: 'https://www.fs.usda.gov/r08/kisatchie/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'medium' },
  { state: 'Maine', abbr: 'ME', agency: 'Maine Dept of Inland Fisheries & Wildlife — ATV', url: 'https://www.maine.gov/ifw/atv-snowmobile/atv/index.html', type: 'state-program', confidence: 'high' },
  { state: 'Maryland', abbr: 'MD', agency: 'Maryland DNR — Off-Road Vehicles (State Forests)', url: 'https://dnr.maryland.gov/forests/pages/orv/trails.aspx', type: 'state-program', confidence: 'high' },
  { state: 'Massachusetts', abbr: 'MA', agency: 'Massachusetts DCR — OHV Program', url: 'https://www.mass.gov/info-details/off-highway-vehicle-program-ohv', type: 'state-program', confidence: 'high' },
  { state: 'Michigan', abbr: 'MI', agency: 'Michigan DNR — ORV Riding', url: 'https://www.michigan.gov/dnr/things-to-do/orv-riding', type: 'state-program', confidence: 'high' },
  { state: 'Minnesota', abbr: 'MN', agency: 'Minnesota DNR — OHV', url: 'https://www.dnr.state.mn.us/ohv/index.html', type: 'state-program', confidence: 'high' },
  { state: 'Mississippi', abbr: 'MS', agency: 'USFS National Forests in Mississippi — OHV', url: 'https://www.fs.usda.gov/r08/mississippi/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'medium' },
  { state: 'Missouri', abbr: 'MO', agency: 'Missouri State Parks — ORV Riding', url: 'https://mostateparks.com/activity/orv-riding', type: 'state-program', confidence: 'high' },
  { state: 'Montana', abbr: 'MT', agency: 'Montana Fish, Wildlife & Parks — OHV', url: 'https://fwp.mt.gov/education/outdoorRec/properATV.html', type: 'state-program', confidence: 'medium' },
  { state: 'Nebraska', abbr: 'NE', agency: 'USFS Nebraska National Forests & Grasslands — OHV', url: 'https://www.fs.usda.gov/r02/nebraska/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'medium' },
  { state: 'Nevada', abbr: 'NV', agency: 'Nevada Commission on Off-Highway Vehicles', url: 'https://ohv.nv.gov', type: 'state-program', confidence: 'high' },
  { state: 'New Hampshire', abbr: 'NH', agency: 'NH State Parks — OHRV (Bureau of Trails)', url: 'https://www.nhstateparks.org/things-to-do/off-road-recreational-vehicles', type: 'state-program', confidence: 'high' },
  { state: 'New Jersey', abbr: 'NJ', agency: 'NJ Motor Vehicle Commission — ATV/Dirt Bike', url: 'https://www.nj.gov/mvc/vehicletopics/mopedatv.htm', type: 'registration', confidence: 'medium' },
  { state: 'New Mexico', abbr: 'NM', agency: 'Ride New Mexico (Dept of Game & Fish OHV)', url: 'https://ridenm.dgf.nm.gov/', type: 'state-program', confidence: 'high' },
  { state: 'New York', abbr: 'NY', agency: 'NY DMV — ATV Information', url: 'https://dmv.ny.gov/more-info/atvs-information-for-owners-and-operators', type: 'registration', confidence: 'medium' },
  { state: 'North Carolina', abbr: 'NC', agency: 'USFS National Forests in NC — OHV', url: 'https://www.fs.usda.gov/r08/northcarolina/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'medium' },
  { state: 'North Dakota', abbr: 'ND', agency: 'ND Parks & Recreation — OHV', url: 'https://www.parkrec.nd.gov/business/recreation-programs/highway-vehicles-ohv', type: 'state-program', confidence: 'high' },
  { state: 'Ohio', abbr: 'OH', agency: 'Ohio DNR — APV Areas (Forestry)', url: 'https://ohiodnr.gov/rules-and-regulations/rules-and-regulations-by-division/forestry/apv-areas-forestry', type: 'state-program', confidence: 'medium' },
  { state: 'Oklahoma', abbr: 'OK', agency: 'TravelOK — ATV & ORV Recreation', url: 'https://www.travelok.com/atv_and_orv', type: 'state-portal', confidence: 'medium' },
  { state: 'Oregon', abbr: 'OR', agency: 'Oregon State Parks — ATV Program', url: 'https://www.oregon.gov/oprd/atv/pages/atv-overview.aspx', type: 'state-program', confidence: 'high' },
  { state: 'Pennsylvania', abbr: 'PA', agency: 'PA DCNR — ATV Riding', url: 'https://www.pa.gov/agencies/dcnr/recreation/what-to-do/atv-riding', type: 'state-program', confidence: 'high' },
  { state: 'Rhode Island', abbr: 'RI', agency: 'RI Dept of Environmental Management', url: 'https://dem.ri.gov/', type: 'registration', confidence: 'medium' },
  { state: 'South Carolina', abbr: 'SC', agency: 'SC Trails (State Trails / OHV)', url: 'https://www.sctrails.net/', type: 'state-portal', confidence: 'medium' },
  { state: 'South Dakota', abbr: 'SD', agency: 'USFS Black Hills National Forest — OHV', url: 'https://www.fs.usda.gov/r02/blackhills/recreation/opportunities/highway-vehicles-ohv', type: 'usfs', confidence: 'high' },
  { state: 'Tennessee', abbr: 'TN', agency: 'TWRA — North Cumberland WMA (OHV)', url: 'https://www.tn.gov/twra/wildlife-management-areas/east-tennessee-r4/north-cumberland-wma.html', type: 'state-program', confidence: 'high' },
  { state: 'Texas', abbr: 'TX', agency: 'Texas Parks & Wildlife — Off-Highway Program', url: 'https://tpwd.texas.gov/state-parks/texas-off-highway-program', type: 'state-program', confidence: 'high' },
  { state: 'Utah', abbr: 'UT', agency: 'Utah Division of Outdoor Recreation', url: 'https://recreation.utah.gov', type: 'state-program', confidence: 'high' },
  { state: 'Vermont', abbr: 'VT', agency: "Vermont ATV Sportsman's Association (VASA)", url: 'https://www.vtvasa.org/', type: 'authority', confidence: 'high' },
  { state: 'Virginia', abbr: 'VA', agency: 'Spearhead Trails (SW Regional Recreation Authority)', url: 'https://www.spearheadtrails.com/', type: 'authority', confidence: 'high' },
  { state: 'Washington', abbr: 'WA', agency: 'Washington DNR — Motorized Recreation', url: 'https://dnr.wa.gov/recreation/where-go-what-do', type: 'state-program', confidence: 'high' },
  { state: 'West Virginia', abbr: 'WV', agency: 'Hatfield-McCoy Trails (Regional Recreation Authority)', url: 'https://trailsheaven.com/', type: 'authority', confidence: 'high' },
  { state: 'Wisconsin', abbr: 'WI', agency: 'Wisconsin DNR — ATV/UTV', url: 'https://dnr.wisconsin.gov/topic/ATV', type: 'state-program', confidence: 'high' },
  { state: 'Wyoming', abbr: 'WY', agency: 'Wyoming State Parks — ORV/Trails', url: 'https://wyoparks.wyo.gov/index.php/orv-trails', type: 'state-program', confidence: 'high' },
];
