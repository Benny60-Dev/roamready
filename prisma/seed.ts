import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RIG_DATABASE = [
  // TIFFIN
  { make: 'Tiffin', model: 'Allegro Bus 45OPP', class: 'CLASS_A', length: 45, height: 13, fuel: 'Diesel', mpg: 7, tank: 150, slides: '3+', amps: '50' },
  { make: 'Tiffin', model: 'Allegro Bus 40IP', class: 'CLASS_A', length: 40, height: 13, fuel: 'Diesel', mpg: 8, tank: 125, slides: '3+', amps: '50' },
  { make: 'Tiffin', model: 'Allegro Red 37BA', class: 'CLASS_A', length: 37, height: 13, fuel: 'Diesel', mpg: 8, tank: 100, slides: '2', amps: '50' },
  { make: 'Tiffin', model: 'Allegro Open Road 34PA', class: 'CLASS_A', length: 34, height: 12, fuel: 'Gas', mpg: 9, tank: 80, slides: '2', amps: '50' },
  { make: 'Tiffin', model: 'Phaeton 40IH', class: 'CLASS_A', length: 40, height: 13, fuel: 'Diesel', mpg: 8, tank: 120, slides: '3+', amps: '50' },
  { make: 'Tiffin', model: 'Wayfarer 24BW', class: 'CLASS_C', length: 24, height: 11, fuel: 'Gas', mpg: 14, tank: 55, slides: '1', amps: '30' },
  // NEWMAR
  { make: 'Newmar', model: 'King Aire 4553', class: 'CLASS_A', length: 45, height: 13, fuel: 'Diesel', mpg: 7, tank: 150, slides: '3+', amps: '50' },
  { make: 'Newmar', model: 'Dutch Star 4369', class: 'CLASS_A', length: 43, height: 13, fuel: 'Diesel', mpg: 8, tank: 125, slides: '3+', amps: '50' },
  { make: 'Newmar', model: 'London Aire 4551', class: 'CLASS_A', length: 45, height: 13, fuel: 'Diesel', mpg: 7, tank: 150, slides: '3+', amps: '50' },
  { make: 'Newmar', model: 'Bay Star 3226', class: 'CLASS_A', length: 32, height: 12, fuel: 'Gas', mpg: 10, tank: 75, slides: '2', amps: '50' },
  { make: 'Newmar', model: 'Ventana 4037', class: 'CLASS_A', length: 40, height: 13, fuel: 'Diesel', mpg: 8, tank: 120, slides: '3+', amps: '50' },
  // WINNEBAGO
  { make: 'Winnebago', model: 'Journey 40R', class: 'CLASS_A', length: 40, height: 13, fuel: 'Diesel', mpg: 8, tank: 100, slides: '3+', amps: '50' },
  { make: 'Winnebago', model: 'Adventurer 35F', class: 'CLASS_A', length: 35, height: 12, fuel: 'Gas', mpg: 9, tank: 80, slides: '2', amps: '50' },
  { make: 'Winnebago', model: 'Vista 31BE', class: 'CLASS_A', length: 31, height: 12, fuel: 'Gas', mpg: 10, tank: 75, slides: '1', amps: '30' },
  { make: 'Winnebago', model: 'Travato 59GL', class: 'CLASS_B', length: 21, height: 10, fuel: 'Gas', mpg: 20, tank: 24, slides: '0', amps: '30' },
  { make: 'Winnebago', model: 'Revel 44E', class: 'CLASS_B', length: 19, height: 10, fuel: 'Diesel', mpg: 22, tank: 24, slides: '0', amps: '30' },
  { make: 'Winnebago', model: 'View 24D', class: 'CLASS_C', length: 24, height: 11, fuel: 'Diesel', mpg: 17, tank: 35, slides: '1', amps: '30' },
  { make: 'Winnebago', model: 'Micro Minnie 2108TB', class: 'TRAVEL_TRAILER', length: 21, height: 10, fuel: null, mpg: null, tank: null, slides: '0', amps: '30' },
  // GRAND DESIGN
  { make: 'Grand Design', model: 'Solitude 380FL', class: 'FIFTH_WHEEL', length: 42, height: 13, fuel: null, mpg: null, tank: null, slides: '3+', amps: '50' },
  { make: 'Grand Design', model: 'Reflection 311BHS', class: 'FIFTH_WHEEL', length: 36, height: 13, fuel: null, mpg: null, tank: null, slides: '2', amps: '50' },
  { make: 'Grand Design', model: 'Imagine 2500RL', class: 'TRAVEL_TRAILER', length: 29, height: 11, fuel: null, mpg: null, tank: null, slides: '1', amps: '30' },
  // KEYSTONE
  { make: 'Keystone', model: 'Montana 3855BR', class: 'FIFTH_WHEEL', length: 42, height: 13, fuel: null, mpg: null, tank: null, slides: '3+', amps: '50' },
  { make: 'Keystone', model: 'Fuzion 413', class: 'TOY_HAULER', length: 45, height: 13, fuel: null, mpg: null, tank: null, slides: '3+', amps: '50' },
  { make: 'Keystone', model: 'Cougar 368MBI', class: 'FIFTH_WHEEL', length: 38, height: 13, fuel: null, mpg: null, tank: null, slides: '3+', amps: '50' },
  // AIRSTREAM
  { make: 'Airstream', model: 'Classic 33FB', class: 'TRAVEL_TRAILER', length: 33, height: 10, fuel: null, mpg: null, tank: null, slides: '0', amps: '30' },
  { make: 'Airstream', model: 'Flying Cloud 25FB', class: 'TRAVEL_TRAILER', length: 25, height: 10, fuel: null, mpg: null, tank: null, slides: '0', amps: '30' },
  { make: 'Airstream', model: 'Atlas 24CB', class: 'CLASS_B', length: 24, height: 10, fuel: 'Diesel', mpg: 18, tank: 26, slides: '0', amps: '30' },
  // ENTEGRA
  { make: 'Entegra', model: 'Cornerstone 45B', class: 'CLASS_A', length: 45, height: 13, fuel: 'Diesel', mpg: 7, tank: 150, slides: '3+', amps: '50' },
  { make: 'Entegra', model: 'Aspire 44R', class: 'CLASS_A', length: 44, height: 13, fuel: 'Diesel', mpg: 7, tank: 150, slides: '3+', amps: '50' },
  { make: 'Entegra', model: 'Reatta 39BH', class: 'CLASS_A', length: 39, height: 13, fuel: 'Diesel', mpg: 8, tank: 120, slides: '2', amps: '50' },
  // THOR
  { make: 'Thor Motor Coach', model: 'Palazzo 37.4', class: 'CLASS_A', length: 37, height: 13, fuel: 'Diesel', mpg: 8, tank: 100, slides: '3+', amps: '50' },
  { make: 'Thor Motor Coach', model: 'Ace 30.3', class: 'CLASS_C', length: 30, height: 11, fuel: 'Gas', mpg: 12, tank: 55, slides: '1', amps: '30' },
  { make: 'Thor Motor Coach', model: 'Gemini 23TE', class: 'CLASS_B', length: 23, height: 10, fuel: 'Diesel', mpg: 22, tank: 24, slides: '0', amps: '30' },
  // FOREST RIVER
  { make: 'Forest River', model: 'Georgetown 5 Series 34H5', class: 'CLASS_A', length: 34, height: 12, fuel: 'Gas', mpg: 9, tank: 80, slides: '2', amps: '50' },
  { make: 'Forest River', model: 'Forester 3011DSF', class: 'CLASS_C', length: 30, height: 11, fuel: 'Gas', mpg: 12, tank: 55, slides: '1', amps: '30' },
  { make: 'Forest River', model: 'Wildwood 28DBUD', class: 'TRAVEL_TRAILER', length: 28, height: 11, fuel: null, mpg: null, tank: null, slides: '1', amps: '30' },
  { make: 'Forest River', model: 'Cardinal 3250BLE', class: 'FIFTH_WHEEL', length: 36, height: 13, fuel: null, mpg: null, tank: null, slides: '3+', amps: '50' },
]

async function main() {
  console.log('Seeding rig database...')
  for (const rig of RIG_DATABASE) {
    await prisma.rigDatabase.upsert({
      where: { id: `${rig.make}-${rig.model}`.replace(/\s+/g, '-').toLowerCase() },
      update: rig,
      create: {
        id: `${rig.make}-${rig.model}`.replace(/\s+/g, '-').toLowerCase(),
        ...rig,
      },
    })
  }
  console.log(`Seeded ${RIG_DATABASE.length} rigs`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
