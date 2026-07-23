import prisma from '../src/config/prisma';

const packages = [
  { name: 'Standard Package', type: 'studio', price: 10000, deposit: 2000, duration: '1 hr 30 mins', images: 6, makeup: true, outfits: 2, styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false },
  { name: 'Economy Package', type: 'studio', price: 15000, deposit: 2000, duration: '2 hrs', images: 12, makeup: true, outfits: 3, styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false },
  { name: 'Executive Package', type: 'studio', price: 20000, deposit: 2000, duration: '2 hrs 30 mins', images: 15, makeup: true, outfits: 4, styling: true, photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false },
  { name: 'Gold Package', type: 'studio', price: 30000, deposit: 2000, duration: '2 hrs 30 mins', images: 20, makeup: true, outfits: 4, styling: true, photobook: true, photobookSize: '8x8"', mount: false, balloonBackdrop: false, wig: false },
  { name: 'Platinum Package', type: 'studio', price: 35000, deposit: 2000, duration: '2 hrs 30 mins', images: 25, makeup: true, outfits: 4, styling: true, photobook: false, photobookSize: null, mount: true, balloonBackdrop: true, wig: false },
  { name: 'VIP Package', type: 'studio', price: 45000, deposit: 2000, duration: '3 hrs 30 mins', images: 25, makeup: true, outfits: 4, styling: true, photobook: true, photobookSize: '8x8"', mount: false, balloonBackdrop: true, wig: false },
  { name: 'VVIP Package', type: 'studio', price: 50000, deposit: 2000, duration: '3 hrs 30 mins', images: 30, makeup: true, outfits: 5, styling: true, photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true },
];

async function main() {
  for (const pkg of packages) {
    await prisma.package.upsert({
      where: { name: pkg.name },
      update: pkg,
      create: pkg,
    });
    console.log(`Seeded: ${pkg.name}`);
  }
  console.log(`Done. ${packages.length} packages seeded.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
