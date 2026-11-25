/**
 * The item master and planogram. In a real store both come from the
 * retailer's merchandising systems; OISS references items only by GTIN, and
 * StoreLayout carries the planogram (which GTIN sits at which facing, its
 * capacity and the shelf price).
 *
 * Every GTIN here uses the GS1 restricted-circulation prefix 20, so it can
 * never match a real item (see spec/identifiers.md).
 */
import type { Department, StoreLayoutModel } from "./layout.ts";
import { Rng } from "./rng.ts";

export interface Item {
  gtin: string;
  name: string;
  department: Department;
  category: string;
  price: number;
  /** Relative rate of sale. The simulator turns it into units per day. */
  velocity: number;
  /** Units per case, for backroom stock. */
  casePack: number;
  shrinkRisk: "low" | "medium" | "high";
  promo: boolean;
}

export interface PlanogramPosition {
  facing: string;
  gtin: string;
  /** How many units wide the item is faced. */
  facings: number;
  capacity: number;
}

/** Departments, with the categories and product names used to make synthetic items. */
const ASSORTMENT: Record<Department, { categories: [string, string[]][]; price: [number, number]; velocity: number; casePack: number; shrink: number }> = {
  breakfast: { categories: [["Cereal", ["Honey Oat Clusters", "Corn Flakes", "Frosted Wheat Squares", "Granola, Almond", "Rice Crisps", "Bran Flakes"]], ["Coffee", ["Medium Roast Ground Coffee", "Dark Roast Whole Bean", "Decaf Ground Coffee", "Coffee Pods, Breakfast Blend"]], ["Breakfast", ["Instant Oatmeal Variety", "Pancake Mix", "Maple Syrup", "Toaster Pastries, Strawberry", "Breakfast Bars"]]], price: [2.99, 12.99], velocity: 8, casePack: 12, shrink: 0.15 },
  snacks: { categories: [["Chips", ["Sea Salt Kettle Chips", "Tortilla Rounds", "Sour Cream Potato Chips", "Cheese Puffs", "Pita Chips"]], ["Crackers", ["Butter Crackers", "Whole Wheat Thins", "Cheddar Crackers"]], ["Candy", ["Milk Chocolate Bar", "Peanut Butter Cups", "Gummy Bears", "Mint Chocolate Thins"]], ["Nuts", ["Roasted Almonds", "Mixed Nuts", "Trail Mix"]]], price: [1.99, 7.99], velocity: 11, casePack: 12, shrink: 0.35 },
  beverages: { categories: [["Water", ["Spring Water 24 Pack", "Sparkling Water, Lime", "Sparkling Water, Grapefruit"]], ["Soda", ["Cola 12 Pack", "Lemon Lime Soda 12 Pack", "Ginger Ale 2 L", "Root Beer 2 L"]], ["Juice", ["Orange Juice 52 oz", "Apple Juice 64 oz", "Cranberry Cocktail"]], ["Sports drinks", ["Sports Drink, Lemon", "Electrolyte Water"]]], price: [1.49, 8.99], velocity: 13, casePack: 6, shrink: 0.1 },
  pantry: { categories: [["Pasta", ["Spaghetti", "Penne", "Elbow Macaroni", "Egg Noodles"]], ["Sauce", ["Marinara Sauce", "Alfredo Sauce", "Salsa, Medium"]], ["Canned", ["Black Beans", "Diced Tomatoes", "Chicken Noodle Soup", "Sweet Corn", "Tuna in Water"]], ["Rice and grains", ["Long Grain White Rice", "Brown Rice", "Quinoa"]]], price: [0.99, 5.99], velocity: 9, casePack: 24, shrink: 0.05 },
  baking: { categories: [["Baking", ["All-Purpose Flour 5 lb", "Granulated Sugar 4 lb", "Brown Sugar", "Baking Soda", "Chocolate Chips", "Vanilla Extract"]], ["Spices", ["Ground Cinnamon", "Black Pepper", "Garlic Powder", "Sea Salt"]], ["Condiments", ["Ketchup", "Yellow Mustard", "Mayonnaise", "Olive Oil", "Canola Oil"]]], price: [1.49, 11.99], velocity: 6, casePack: 12, shrink: 0.1 },
  household: { categories: [["Paper", ["Paper Towels 6 Roll", "Bath Tissue 12 Roll", "Facial Tissue", "Paper Plates"]], ["Cleaning", ["Dish Soap", "Laundry Detergent", "All-Purpose Cleaner", "Sponges 6 Pack"]], ["Storage", ["Trash Bags 40 ct", "Zip Bags, Gallon", "Aluminum Foil"]]], price: [2.49, 18.99], velocity: 5, casePack: 6, shrink: 0.2 },
  frozen: { categories: [["Frozen meals", ["Cheese Pizza", "Pepperoni Pizza", "Chicken Burrito Bowl", "Macaroni and Cheese"]], ["Frozen vegetables", ["Peas", "Broccoli Florets", "Mixed Vegetables", "Sweet Corn"]], ["Ice cream", ["Vanilla Ice Cream", "Chocolate Ice Cream", "Fruit Bars"]], ["Frozen breakfast", ["Waffles", "Breakfast Sandwiches"]]], price: [2.49, 9.99], velocity: 7, casePack: 12, shrink: 0.1 },
  produce: { categories: [["Fruit", ["Bananas", "Gala Apples", "Navel Oranges", "Strawberries 1 lb", "Blueberries", "Lemons", "Avocados"]], ["Vegetables", ["Romaine Hearts", "Baby Spinach", "Carrots 2 lb", "Yellow Onions 3 lb", "Russet Potatoes 5 lb", "Tomatoes on the Vine", "Cucumbers"]]], price: [0.79, 6.99], velocity: 18, casePack: 20, shrink: 0.2 },
  dairy: { categories: [["Milk", ["Whole Milk Gallon", "2% Milk Gallon", "Oat Milk", "Almond Milk"]], ["Eggs", ["Large Eggs Dozen", "Cage-Free Eggs Dozen"]], ["Yogurt", ["Greek Yogurt, Plain", "Strawberry Yogurt Cups", "Vanilla Yogurt"]], ["Cheese", ["Shredded Cheddar", "Sliced Swiss", "String Cheese", "Cream Cheese"]], ["Butter", ["Salted Butter", "Unsalted Butter"]]], price: [1.29, 7.99], velocity: 16, casePack: 12, shrink: 0.15 },
  bakery: { categories: [["Bread", ["Sourdough Loaf", "Whole Wheat Bread", "French Baguette", "Dinner Rolls 12 ct"]], ["Sweets", ["Chocolate Chip Cookies", "Blueberry Muffins 4 ct", "Croissants 4 ct", "Apple Pie"]]], price: [2.49, 9.99], velocity: 12, casePack: 6, shrink: 0.25 },
  deli: { categories: [["Prepared", ["Rotisserie Chicken", "Turkey Sandwich", "Garden Salad", "Sushi Roll"]], ["Sliced", ["Sliced Turkey Breast", "Sliced Ham", "Hummus"]]], price: [3.99, 9.99], velocity: 12, casePack: 6, shrink: 0.3 },
  meat_and_seafood: { categories: [["Beef", ["Ground Beef 1 lb", "Ribeye Steak", "Beef Stew Meat"]], ["Poultry", ["Chicken Breasts", "Chicken Thighs", "Ground Turkey"]], ["Pork", ["Pork Chops", "Bacon"]], ["Seafood", ["Salmon Fillet", "Shrimp 1 lb", "Cod Fillet"]]], price: [4.99, 19.99], velocity: 9, casePack: 8, shrink: 0.4 },
  promo: { categories: [["Promotion", ["Holiday Cookie Tin", "Cranberry Sauce", "Stuffing Mix", "Pumpkin Pie Filling", "Party Mix", "Hot Cocoa Mix", "Sparkling Cider", "Gravy Mix", "Fried Onions", "Pecan Halves", "Marshmallows", "Pie Crusts"]]], price: [1.99, 8.99], velocity: 12, casePack: 12, shrink: 0.3 },
};

const BRANDS = ["Demo Market", "Harbor Lane", "Sunny Acres", "Northfield", "Bramble & Co", "Tall Pine", "Copper Kettle", "Blue Mesa"];

/** GS1 mod-10 check digit over the digits given. */
export function checkDigit(body: string): number {
  let total = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    total += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10;
}

/** A synthetic GTIN-14 from the GS1 restricted-circulation range 20: 0 + 20 + item number (10 digits) + check digit. */
export function syntheticGtin(n: number): string {
  const body = `020${String(n).padStart(10, "0")}`;
  return body + checkDigit(body);
}

/** Round to a shelf price ending in .29, .49, .79 or .99. */
function shelfPrice(rng: Rng, lo: number, hi: number): number {
  const base = Math.floor(rng.uniform(lo, hi));
  const cents = rng.pick([0.29, 0.49, 0.79, 0.99, 0.99]);
  return Math.round((Math.max(0, base) + cents) * 100) / 100;
}

export interface Catalog {
  items: Item[];
  byGtin: Map<string, Item>;
  planogram: PlanogramPosition[];
  byFacing: Map<string, PlanogramPosition>;
}

/** Make one item per planogram position, so every facing has its own GTIN. */
export function buildCatalog(layout: StoreLayoutModel, seed: Rng): Catalog {
  const rng = seed.fork("catalog");
  const items: Item[] = [];
  const planogram: PlanogramPosition[] = [];
  const fixtureDept = new Map(layout.fixtures.map((f) => [f.id, f.department]));
  const used = new Map<Department, number>();
  let n = 1000;

  for (const slot of layout.slots) {
    const department = fixtureDept.get(slot.fixture);
    if (!department) continue;
    const spec = ASSORTMENT[department];
    const k = used.get(department) ?? 0;
    used.set(department, k + 1);
    const allNames = spec.categories.flatMap(([category, names]) => names.map((name) => ({ category, name })));
    const base = allNames[k % allNames.length]!;
    const brand = BRANDS[Math.floor(k / allNames.length) % BRANDS.length]!;
    const promo = department === "promo";
    const item: Item = {
      gtin: syntheticGtin(++n),
      name: `${brand} ${base.name}`,
      department,
      category: base.category,
      price: shelfPrice(rng, spec.price[0], spec.price[1]),
      velocity: Math.round(rng.lognormal(spec.velocity, 0.6) * (promo ? 1.6 : 1) * 100) / 100,
      casePack: spec.casePack,
      shrinkRisk: spec.shrink > 0.3 ? "high" : spec.shrink > 0.12 ? "medium" : "low",
      promo,
    };
    items.push(item);
    const facings = Math.max(1, Math.round(slot.width / 0.3));
    planogram.push({ facing: slot.id, gtin: item.gtin, facings, capacity: 0 });
  }
  return { items, byGtin: new Map(items.map((i) => [i.gtin, i])), planogram, byFacing: new Map(planogram.map((p) => [p.facing, p])) };
}

/**
 * Set each position's shelf capacity from the forecast: one to two days of
 * supply, at least one row deep. Planners size high sellers this way.
 */
export function sizePlanogram(catalog: Catalog, forecastUnitsPerDay: number, seed: Rng): void {
  const rng = seed.fork("capacity");
  const totalVelocity = catalog.items.reduce((s, i) => s + i.velocity, 0);
  for (const pos of catalog.planogram) {
    const item = catalog.byGtin.get(pos.gtin)!;
    const daily = (forecastUnitsPerDay * item.velocity) / totalVelocity;
    pos.capacity = Math.max(pos.facings * 2, Math.round(daily * rng.uniform(0.9, 1.7)));
  }
}
