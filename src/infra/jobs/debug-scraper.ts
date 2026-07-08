import { StatusInvestScraper } from '../services/statusinvest-scraper.ts';

const scraper = new StatusInvestScraper();

console.log("=== XPML11 (FII) ===");
const fii = await scraper.fetchFII("XPML11");
console.log(`Preço: ${fii.price}`);
console.log(`DY: ${fii.dy}`);
console.log(`P/VP: ${fii.pvp}`);
console.log(`Proventos: ${fii.dividendsHistory.length} registros`);
if (fii.dividendsHistory.length > 0) {
  console.log(`  Último: ${JSON.stringify(fii.dividendsHistory[0])}`);
}

console.log("\n=== PETR4 (Ação) ===");
const stock = await scraper.fetchStock("PETR4");
console.log(`Preço: ${stock.price}`);
console.log(`DY: ${stock.dy}`);
console.log(`P/L: ${stock.pl}`);
console.log(`P/VP: ${stock.pvp}`);
console.log(`Setor: ${stock.sector}`);
console.log(`Proventos: ${stock.dividendsHistory.length} registros`);

console.log("\n=== API PROVENTOS PETR4 ===");
const resp = await fetch("https://statusinvest.com.br/acao/companytickerprovents?ticker=PETR4&chartProventsType=2", {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
});
const data = await resp.json();
console.log(JSON.stringify(data).slice(0, 600));

console.log("\n=== API PROVENTOS HGLG11 ===");
const resp2 = await fetch("https://statusinvest.com.br/fii/companytickerprovents?ticker=HGLG11", {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
});
const data2 = await resp2.json();
console.log(JSON.stringify(data2).slice(0, 600));
