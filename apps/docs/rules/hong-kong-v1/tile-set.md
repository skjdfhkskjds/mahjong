# Tile set and canonical identity

The profile uses 144 physical tiles.

| IDs     | Kinds                                     | Copies |
| ------- | ----------------------------------------- | ------ |
| 0–35    | Characters 1–9                            | 4 each |
| 36–71   | Circles 1–9                               | 4 each |
| 72–107  | Bamboo 1–9                                | 4 each |
| 108–123 | East, South, West, North                  | 4 each |
| 124–135 | Red, green, white dragons                 | 4 each |
| 136–139 | Spring, summer, autumn, winter            | 1 each |
| 140–143 | Plum, orchid, chrysanthemum, bamboo plant | 1 each |

Within a four-copy kind, copy indices run from 0 through 3 even though copy index is not game semantics. For example, character 1 occupies IDs 0–3 and character 9 occupies 32–35.

The canonical serialized suit token is `"bamboo"`. The unique flower at ID 143 also uses the name token `"bamboo"`; prose calls it “bamboo plant,” and the surrounding tile-family field keeps the two concepts unambiguous.

Bonus numbers and matching seats are:

| Number | Seat  | Season | Flower        |
| ------ | ----- | ------ | ------------- |
| 1      | East  | Spring | Plum          |
| 2      | South | Summer | Orchid        |
| 3      | West  | Autumn | Chrysanthemum |
| 4      | North | Winter | Bamboo plant  |

Bonus matching affects later scoring, which remains unresolved. Every bonus is exposed and replaced regardless of whether it matches its owner's seat.

The ID order is an engineering compatibility contract, not a physical Mahjong rule. Once deterministic shuffle vectors are published, v1 must never renumber these tiles.
