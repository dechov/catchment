// The communities each reservoir took. Names and figures from the Wikipedia articles on each
// reservoir and its "List of flooded towns in the United States" (read November 2026); where an
// article gives no count, none is shown. Several hamlets were rebuilt nearby under the same name.
export const DISPLACED: Record<string, { places: string; note?: string }> = {
  "Ashokan Reservoir": {
    places: "Boiceville, Brown's Station, Glenford, Olive, Olive Bridge, Shokan, West Hurley, West Shokan and others",
    note: "about 2,000 residents displaced; 12 communities; cemeteries moved",
  },
  "Schoharie Reservoir": { places: "Gilboa" },
  "Kensico Reservoir": { places: "Kensico" },
  "Rondout Reservoir": { places: "Lackawack, Montela, Eureka", note: "condemned and flooded" },
  "Neversink Reservoir": { places: "Neversink (moved a few miles), Bittersweet" },
  "Pepacton Reservoir": { places: "Arena, Pepacton, Shavertown, Union Grove", note: "974 people displaced" },
  "Cannonsville Reservoir": { places: "Cannonsville, Rock Royal" },
};
