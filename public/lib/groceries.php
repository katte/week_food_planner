<?php
/*
 * Spesa e costi: ingredienti, ricette dei piatti, articoli comprati e scontrini.
 * Incluso da api.php, che fornisce db(), tables(), transaction(), HttpError e le utilità.
 *
 * Come si calcolano i prezzi
 *   Ogni riga di scontrino viene ricondotta a una quantità in kg, litri o pezzi:
 *     - prodotto pesato: il peso stampato (es. 0,456 kg);
 *     - confezione con formato (es. 2 × 500 g): 1 kg;
 *     - altrimenti: il numero di pezzi.
 *   Da lì il prezzo "di riferimento" al kg / al litro / al pezzo, sia pieno sia pagato.
 *   Il costo dei piatti usa il prezzo pieno dell'acquisto più recente di un articolo
 *   collegato all'ingrediente: lo calcola il browser con i prezzi restituiti da 'ingredients'.
 */

declare(strict_types=1);

const PRICE_UNITS = ['kg', 'l', 'pz'];
// Unità delle quantità => [unità di prezzo corrispondente, fattore di conversione]
const AMOUNT_UNITS = [
    'g' => ['kg', 0.001],
    'kg' => ['kg', 1.0],
    'ml' => ['l', 0.001],
    'l' => ['l', 1.0],
    'pz' => ['pz', 1.0],
];
const PRODUCT_CATEGORIES = ['alimentari', 'bevande', 'casa', 'igiene', 'animali', 'altro'];

// ---------------------------------------------------------------------------
// Tabelle
// ---------------------------------------------------------------------------

function grocerySchema(array $t, string $options): array
{
    return [
        "CREATE TABLE IF NOT EXISTS {$t['ingredients']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(80) NOT NULL,
            unit VARCHAR(2) NOT NULL DEFAULT 'kg' COMMENT 'unità del prezzo: kg | l | pz',
            negligible TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = non entra nel costo dei piatti',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (name)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['dish_ingredients']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            dish_id INT UNSIGNED NOT NULL,
            ingredient_id INT UNSIGNED NOT NULL,
            position TINYINT UNSIGNED NOT NULL,
            quantity DECIMAL(10,3) NULL,
            unit VARCHAR(2) NOT NULL COMMENT 'g | kg | ml | l | pz',
            negligible TINYINT(1) NULL COMMENT 'NULL = come indicato sull''ingrediente',
            PRIMARY KEY (id),
            KEY idx_dish (dish_id, position),
            KEY idx_ingredient (ingredient_id),
            FOREIGN KEY (dish_id) REFERENCES {$t['dishes']} (id) ON DELETE CASCADE,
            FOREIGN KEY (ingredient_id) REFERENCES {$t['ingredients']} (id) ON DELETE CASCADE
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['products']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(120) NOT NULL,
            brand VARCHAR(60) NOT NULL DEFAULT '',
            category VARCHAR(20) NOT NULL DEFAULT 'altro',
            ingredient_id INT UNSIGNED NULL,
            package_size DECIMAL(10,3) NULL,
            package_unit VARCHAR(2) NULL,
            price_per_kg DECIMAL(10,3) NULL COMMENT 'per le cose pesate al banco: il peso si ricava dall''importo',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (name),
            KEY idx_ingredient (ingredient_id),
            FOREIGN KEY (ingredient_id) REFERENCES {$t['ingredients']} (id) ON DELETE SET NULL
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['product_aliases']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            product_id INT UNSIGNED NOT NULL,
            store VARCHAR(80) NOT NULL,
            description VARCHAR(200) NOT NULL COMMENT 'testo come stampato sullo scontrino',
            alias_hash CHAR(40) NOT NULL COMMENT 'sha1 di negozio|descrizione normalizzati',
            PRIMARY KEY (id),
            UNIQUE KEY uq_alias (alias_hash),
            KEY idx_description (description(100)),
            KEY idx_product (product_id),
            FOREIGN KEY (product_id) REFERENCES {$t['products']} (id) ON DELETE CASCADE
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['receipts']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            store VARCHAR(80) NOT NULL,
            address VARCHAR(200) NOT NULL DEFAULT '',
            purchased_on DATE NOT NULL,
            purchased_time TIME NULL,
            total DECIMAL(10,2) NULL,
            extra_discount DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT 'sconti sul totale (buoni, coupon)',
            warnings TEXT NOT NULL COMMENT 'avvisi in JSON',
            source_json MEDIUMTEXT NOT NULL COMMENT 'JSON originale restituito dall''AI',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            KEY idx_date (purchased_on)
        ) $options",
        "CREATE TABLE IF NOT EXISTS {$t['receipt_items']} (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            receipt_id INT UNSIGNED NOT NULL,
            position SMALLINT UNSIGNED NOT NULL,
            description VARCHAR(200) NOT NULL COMMENT 'testo come stampato sullo scontrino',
            name VARCHAR(120) NOT NULL DEFAULT '' COMMENT 'nome leggibile proposto dall''AI',
            brand VARCHAR(60) NOT NULL DEFAULT '',
            category VARCHAR(20) NOT NULL DEFAULT 'altro',
            product_id INT UNSIGNED NULL,
            quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
            weight_kg DECIMAL(10,3) NULL,
            weight_from_product TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = peso ricavato dal prezzo al kg dell''articolo',
            package_size DECIMAL(10,3) NULL,
            package_unit VARCHAR(2) NULL,
            package_estimated TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = formato dedotto, non stampato',
            package_from_product TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = formato preso dalla scheda dell''articolo',
            unit_price DECIMAL(10,3) NULL,
            price_full DECIMAL(10,2) NOT NULL COMMENT 'prima degli sconti',
            discount DECIMAL(10,2) NOT NULL DEFAULT 0,
            price_paid DECIMAL(10,2) NOT NULL,
            ref_amount DECIMAL(12,4) NULL COMMENT 'quantità in ref_unit',
            ref_unit VARCHAR(2) NULL COMMENT 'kg | l | pz',
            ref_price_full DECIMAL(12,4) NULL COMMENT 'prezzo pieno per ref_unit',
            ref_price_paid DECIMAL(12,4) NULL COMMENT 'prezzo pagato per ref_unit',
            PRIMARY KEY (id),
            KEY idx_receipt (receipt_id, position),
            KEY idx_product (product_id),
            FOREIGN KEY (receipt_id) REFERENCES {$t['receipts']} (id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES {$t['products']} (id) ON DELETE SET NULL
        ) $options",
    ];
}

// Colonne aggiunte alle tabelle già esistenti dopo la loro prima versione.
function migrateSchema(): void
{
    $t = tables();
    $columns = [
        [$t['dishes'], 'servings', 'TINYINT UNSIGNED NOT NULL DEFAULT 4 AFTER notes'],
        [$t['receipt_items'], 'package_from_product', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER package_estimated'],
        [$t['products'], 'price_per_kg', 'DECIMAL(10,3) NULL AFTER package_unit'],
        [$t['receipt_items'], 'weight_from_product', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER weight_kg'],
        [$t['shopping'], 'category', 'VARCHAR(20) NULL AFTER text'],
    ];
    foreach ($columns as [$table, $column, $definition]) {
        if (!db()->query("SHOW COLUMNS FROM $table LIKE '$column'")->fetchAll()) {
            db()->exec("ALTER TABLE $table ADD COLUMN $column $definition");
        }
    }
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

// Minuscolo, senza accenti e spazi doppi: per confrontare nomi e descrizioni.
function fold(string $text): string
{
    static $accents = [
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ä' => 'a', 'À' => 'a', 'Á' => 'a', 'Â' => 'a', 'Ä' => 'a',
        'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e', 'È' => 'e', 'É' => 'e', 'Ê' => 'e', 'Ë' => 'e',
        'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'Ì' => 'i', 'Í' => 'i', 'Î' => 'i', 'Ï' => 'i',
        'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'ö' => 'o', 'Ò' => 'o', 'Ó' => 'o', 'Ô' => 'o', 'Ö' => 'o',
        'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'Ù' => 'u', 'Ú' => 'u', 'Û' => 'u', 'Ü' => 'u',
        'ç' => 'c', 'Ç' => 'c', 'ñ' => 'n', 'Ñ' => 'n',
    ];
    return strtolower(trim((string) preg_replace('/\s+/u', ' ', strtr($text, $accents))));
}

// Numero dal JSON dell'AI: accetta anche stringhe come "1,29" o "€ 2.50". null se manca.
function toNumber($value): ?float
{
    if (is_int($value) || is_float($value)) {
        return (float) $value;
    }
    if (is_string($value)) {
        $value = str_replace(',', '.', str_replace([' ', '€'], '', $value));
        if (is_numeric($value)) {
            return (float) $value;
        }
    }
    return null;
}

function nullableFloat($value): ?float
{
    return $value === null ? null : (float) $value;
}

function euro(float $value): string
{
    return number_format($value, 2, ',', '.') . ' €';
}

function idFromInput($value): ?int
{
    return is_int($value) || (is_string($value) && ctype_digit($value)) ? (int) $value : null;
}

// Tutti gli acquisti collegati a un articolo, dal più recente.
function purchases(string $where = '', array $params = []): array
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT ri.id, ri.receipt_id, ri.description, ri.product_id, p.ingredient_id, p.name AS product,
                ri.quantity, ri.weight_kg, ri.weight_from_product,
                ri.package_size, ri.package_unit, ri.package_estimated, ri.package_from_product,
                ri.price_full, ri.discount, ri.price_paid, ri.ref_unit, ri.ref_price_full, ri.ref_price_paid,
                r.purchased_on, r.store
         FROM {$t['receipt_items']} ri
         JOIN {$t['products']} p ON p.id = ri.product_id
         JOIN {$t['receipts']} r ON r.id = ri.receipt_id
         $where
         ORDER BY r.purchased_on DESC, r.purchased_time DESC, ri.id DESC"
    );
    $stmt->execute($params);
    return $stmt->fetchAll();
}

function purchaseInfo(array $row): array
{
    return [
        'id' => (string) $row['id'],
        'receiptId' => (string) $row['receipt_id'],
        'description' => $row['description'],
        'date' => $row['purchased_on'],
        'store' => $row['store'],
        'quantity' => (float) $row['quantity'],
        'weightKg' => nullableFloat($row['weight_kg']),
        'weightFromProduct' => (bool) $row['weight_from_product'],
        'packageSize' => nullableFloat($row['package_size']),
        'packageUnit' => $row['package_unit'],
        'packageEstimated' => (bool) $row['package_estimated'],
        'packageFromProduct' => (bool) $row['package_from_product'],
        'priceFull' => (float) $row['price_full'],
        'discount' => (float) $row['discount'],
        'pricePaid' => (float) $row['price_paid'],
        'refUnit' => $row['ref_unit'],
        'refPriceFull' => nullableFloat($row['ref_price_full']),
        'refPricePaid' => nullableFloat($row['ref_price_paid']),
    ];
}

// ---------------------------------------------------------------------------
// Ingredienti
// ---------------------------------------------------------------------------

// Ingredienti con l'ultimo prezzo per unità (kg / l / pz) e quanto sono usati.
function listIngredients(?int $onlyId = null): array
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT i.id, i.name, i.unit, i.negligible,
                (SELECT COUNT(*) FROM {$t['products']} p WHERE p.ingredient_id = i.id) AS products,
                (SELECT COUNT(DISTINCT di.dish_id) FROM {$t['dish_ingredients']} di WHERE di.ingredient_id = i.id) AS dishes
         FROM {$t['ingredients']} i
         " . ($onlyId === null ? '' : 'WHERE i.id = ?') . '
         ORDER BY i.name'
    );
    $stmt->execute($onlyId === null ? [] : [$onlyId]);

    $prices = [];
    foreach (purchases('WHERE p.ingredient_id IS NOT NULL AND ri.ref_price_full IS NOT NULL') as $row) {
        $prices[(int) $row['ingredient_id']][$row['ref_unit']] ??= [
            'value' => (float) $row['ref_price_full'],
            'paid' => nullableFloat($row['ref_price_paid']),
            'date' => $row['purchased_on'],
            'store' => $row['store'],
            'product' => $row['product'],
        ];
    }

    return array_map(function (array $row) use ($prices) {
        $id = (int) $row['id'];
        return [
            'id' => (string) $id,
            'name' => $row['name'],
            'unit' => $row['unit'],
            'negligible' => (bool) $row['negligible'],
            // Ultimo prezzo pieno per ogni unità in cui è stato comprato: il costo usa quella dell'ingrediente.
            'prices' => (object) ($prices[$id] ?? []),
            'products' => (int) $row['products'],
            'dishes' => (int) $row['dishes'],
        ];
    }, $stmt->fetchAll());
}

function findIngredient(int $id): array
{
    $list = listIngredients($id);
    if (!$list) {
        throw new HttpError(404, 'Ingrediente non trovato');
    }
    return $list[0];
}

function parseIngredient(array $input): array
{
    $name = cleanLine($input['name'] ?? null, 80);
    if ($name === '') {
        throw new HttpError(400, "Il nome dell'ingrediente è obbligatorio");
    }
    $unit = $input['unit'] ?? 'kg';
    return [
        'name' => $name,
        'unit' => in_array($unit, PRICE_UNITS, true) ? $unit : 'kg',
        'negligible' => !empty($input['negligible']),
    ];
}

function assertIngredientNameAvailable(string $name, int $exceptId = 0): void
{
    $t = tables();
    $stmt = db()->prepare("SELECT name FROM {$t['ingredients']} WHERE name = ? AND id <> ? LIMIT 1");
    $stmt->execute([$name, $exceptId]);
    $clash = $stmt->fetchColumn();
    if ($clash !== false) {
        throw new HttpError(409, "Hai già un ingrediente chiamato «{$clash}»");
    }
}

function createIngredient(array $input): array
{
    $t = tables();
    $ingredient = parseIngredient($input);
    assertIngredientNameAvailable($ingredient['name']);
    db()->prepare("INSERT INTO {$t['ingredients']} (name, unit, negligible, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())")
        ->execute([$ingredient['name'], $ingredient['unit'], $ingredient['negligible'] ? 1 : 0]);
    return findIngredient((int) db()->lastInsertId());
}

function updateIngredient(int $id, array $input): array
{
    $t = tables();
    findIngredient($id);
    $ingredient = parseIngredient($input);
    assertIngredientNameAvailable($ingredient['name'], $id);
    db()->prepare("UPDATE {$t['ingredients']} SET name = ?, unit = ?, negligible = ? WHERE id = ?")
        ->execute([$ingredient['name'], $ingredient['unit'], $ingredient['negligible'] ? 1 : 0, $id]);
    return findIngredient($id);
}

// Elimina l'ingrediente: sparisce dalle ricette e gli articoli restano senza ingrediente.
function deleteIngredient(int $id): void
{
    $t = tables();
    $stmt = db()->prepare("DELETE FROM {$t['ingredients']} WHERE id = ?");
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Ingrediente non trovato');
    }
}

// Id dell'ingrediente con questo nome; se non esiste lo crea con l'unità di prezzo indicata.
function ingredientIdByName(string $name, string $unit): ?int
{
    $t = tables();
    $name = cleanLine($name, 80);
    if ($name === '') {
        return null;
    }
    $stmt = db()->prepare("SELECT id FROM {$t['ingredients']} WHERE name = ? LIMIT 1");
    $stmt->execute([$name]);
    $id = $stmt->fetchColumn();
    if ($id !== false) {
        return (int) $id;
    }
    db()->prepare("INSERT INTO {$t['ingredients']} (name, unit, negligible, created_at) VALUES (?, ?, 0, UTC_TIMESTAMP())")
        ->execute([$name, in_array($unit, PRICE_UNITS, true) ? $unit : 'kg']);
    return (int) db()->lastInsertId();
}

// ---------------------------------------------------------------------------
// Ricette
// ---------------------------------------------------------------------------

// Aggiunge a ogni piatto le righe della sua ricetta.
function attachRecipes(array $dishes): array
{
    if (!$dishes) {
        return $dishes;
    }
    $t = tables();
    $ids = array_map('intval', array_column($dishes, 'id'));
    $stmt = db()->prepare(
        "SELECT dish_id, ingredient_id, quantity, unit, negligible FROM {$t['dish_ingredients']}
         WHERE dish_id IN (" . implode(',', array_fill(0, count($ids), '?')) . ')
         ORDER BY dish_id, position'
    );
    $stmt->execute($ids);
    $recipes = [];
    foreach ($stmt->fetchAll() as $row) {
        $recipes[(int) $row['dish_id']][] = [
            'ingredientId' => (string) $row['ingredient_id'],
            'quantity' => nullableFloat($row['quantity']),
            'unit' => $row['unit'],
            // null = come indicato sull'ingrediente
            'negligible' => $row['negligible'] === null ? null : (bool) $row['negligible'],
        ];
    }
    foreach ($dishes as &$dish) {
        $dish['recipe'] = $recipes[(int) $dish['id']] ?? [];
    }
    unset($dish);
    return $dishes;
}

// Salva porzioni e ricetta di un piatto. Gli ingredienti indicati per nome e non ancora
// esistenti vengono creati, con l'unità di prezzo che corrisponde a quella usata (g → kg...).
function saveRecipe(int $dishId, array $input): array
{
    $t = tables();
    findDish($dishId);
    $servings = max(1, min(50, (int) ($input['servings'] ?? 4)));

    $lines = [];
    foreach (is_array($input['lines'] ?? null) ? $input['lines'] : [] as $line) {
        if (!is_array($line)) {
            continue;
        }
        $unit = $line['unit'] ?? '';
        if (!is_string($unit) || !isset(AMOUNT_UNITS[$unit])) {
            throw new HttpError(400, 'Unità non valida: usa g, kg, ml, l o pz');
        }
        $quantity = toNumber($line['quantity'] ?? null);
        $lines[] = [
            'ingredientId' => idFromInput($line['ingredientId'] ?? null),
            'ingredientName' => is_string($line['ingredientName'] ?? null) ? $line['ingredientName'] : '',
            'quantity' => $quantity !== null && $quantity > 0 ? round($quantity, 3) : null,
            'unit' => $unit,
            'negligible' => is_bool($line['negligible'] ?? null) ? $line['negligible'] : null,
        ];
    }

    transaction(function (PDO $pdo) use ($t, $dishId, $servings, $lines) {
        $pdo->prepare("UPDATE {$t['dishes']} SET servings = ? WHERE id = ?")->execute([$servings, $dishId]);
        $pdo->prepare("DELETE FROM {$t['dish_ingredients']} WHERE dish_id = ?")->execute([$dishId]);
        $exists = $pdo->prepare("SELECT id FROM {$t['ingredients']} WHERE id = ?");
        $insert = $pdo->prepare(
            "INSERT INTO {$t['dish_ingredients']} (dish_id, ingredient_id, position, quantity, unit, negligible)
             VALUES (?, ?, ?, ?, ?, ?)"
        );
        $position = 0;
        foreach (array_slice($lines, 0, 60) as $line) {
            $ingredientId = null;
            if ($line['ingredientId'] !== null) {
                $exists->execute([$line['ingredientId']]);
                $ingredientId = $exists->fetchColumn() === false ? null : $line['ingredientId'];
            }
            $ingredientId = $ingredientId ?? ingredientIdByName($line['ingredientName'], AMOUNT_UNITS[$line['unit']][0]);
            if ($ingredientId === null) {
                continue;
            }
            $negligible = $line['negligible'] === null ? null : ($line['negligible'] ? 1 : 0);
            $insert->execute([$dishId, $ingredientId, $position++, $line['quantity'], $line['unit'], $negligible]);
        }
    });

    return findDish($dishId);
}

// ---------------------------------------------------------------------------
// Articoli (le cose comprate, riconosciute dalle righe degli scontrini)
// ---------------------------------------------------------------------------

function listProducts(?int $onlyId = null): array
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT p.id, p.name, p.brand, p.category, p.ingredient_id, i.name AS ingredient,
                p.package_size, p.package_unit, p.price_per_kg,
                (SELECT COUNT(*) FROM {$t['receipt_items']} ri WHERE ri.product_id = p.id) AS purchases
         FROM {$t['products']} p
         LEFT JOIN {$t['ingredients']} i ON i.id = p.ingredient_id
         " . ($onlyId === null ? '' : 'WHERE p.id = ?') . '
         ORDER BY p.name'
    );
    $stmt->execute($onlyId === null ? [] : [$onlyId]);

    $last = [];
    foreach (purchases($onlyId === null ? '' : 'WHERE ri.product_id = ?', $onlyId === null ? [] : [$onlyId]) as $row) {
        $last[(int) $row['product_id']] ??= purchaseInfo($row);
    }

    return array_map(function (array $row) use ($last) {
        $id = (int) $row['id'];
        return [
            'id' => (string) $id,
            'name' => $row['name'],
            'brand' => $row['brand'],
            'category' => $row['category'],
            'ingredientId' => $row['ingredient_id'] === null ? null : (string) $row['ingredient_id'],
            'ingredient' => $row['ingredient'],
            'packageSize' => nullableFloat($row['package_size']),
            'packageUnit' => $row['package_unit'],
            'pricePerKg' => nullableFloat($row['price_per_kg']),
            'purchases' => (int) $row['purchases'],
            'last' => $last[$id] ?? null,
        ];
    }, $stmt->fetchAll());
}

// Un articolo con tutti i suoi acquisti e le descrizioni con cui compare sugli scontrini.
function getProduct(int $id): array
{
    $t = tables();
    $list = listProducts($id);
    if (!$list) {
        throw new HttpError(404, 'Articolo non trovato');
    }
    $history = array_map('purchaseInfo', purchases('WHERE ri.product_id = ?', [$id]));
    $stmt = db()->prepare("SELECT store, description FROM {$t['product_aliases']} WHERE product_id = ? ORDER BY store, description");
    $stmt->execute([$id]);
    return $list[0] + ['history' => $history, 'aliases' => $stmt->fetchAll()];
}

function updateProduct(int $id, array $input): array
{
    $t = tables();
    $current = getProduct($id);
    $name = cleanLine($input['name'] ?? null, 120);
    if ($name === '') {
        throw new HttpError(400, "Il nome dell'articolo è obbligatorio");
    }
    $stmt = db()->prepare("SELECT name FROM {$t['products']} WHERE name = ? AND id <> ? LIMIT 1");
    $stmt->execute([$name, $id]);
    $clash = $stmt->fetchColumn();
    if ($clash !== false) {
        throw new HttpError(409, "Hai già un articolo chiamato «{$clash}»: per riunirli usa «Unisci»");
    }

    $category = $input['category'] ?? 'altro';
    $size = toNumber($input['packageSize'] ?? null);
    $unit = $input['packageUnit'] ?? null;
    $hasPackage = $size !== null && $size > 0 && is_string($unit) && isset(AMOUNT_UNITS[$unit]);
    $perKgInput = is_string($input['pricePerKg'] ?? null) ? trim($input['pricePerKg']) : ($input['pricePerKg'] ?? null);
    $perKg = $perKgInput === null || $perKgInput === '' ? null : toNumber($perKgInput);
    if ($perKgInput !== null && $perKgInput !== '' && ($perKg === null || $perKg <= 0)) {
        throw new HttpError(400, 'Prezzo al kg non valido');
    }
    if ($hasPackage && $perKg !== null) {
        throw new HttpError(400, 'Indica il formato oppure il prezzo al kg, non tutti e due');
    }
    // Un ingrediente nuovo prende l'unità di prezzo del formato, o dell'ultimo acquisto.
    $priceUnit = $hasPackage ? AMOUNT_UNITS[$unit][0] : ($perKg !== null ? 'kg' : ($current['last']['refUnit'] ?? 'kg'));
    $ingredientId = ingredientIdByName(is_string($input['ingredient'] ?? null) ? $input['ingredient'] : '', $priceUnit);
    $repriceAll = !empty($input['repriceAll']);

    transaction(function (PDO $pdo) use ($t, $id, $name, $input, $category, $ingredientId, $hasPackage, $size, $unit, $perKg, $repriceAll) {
        $pdo->prepare(
            "UPDATE {$t['products']}
             SET name = ?, brand = ?, category = ?, ingredient_id = ?, package_size = ?, package_unit = ?, price_per_kg = ?
             WHERE id = ?"
        )->execute([
            $name,
            cleanLine($input['brand'] ?? null, 60),
            in_array($category, PRODUCT_CATEGORIES, true) ? $category : 'altro',
            $ingredientId,
            $hasPackage ? round($size, 3) : null,
            $hasPackage ? $unit : null,
            $perKg === null ? null : round($perKg, 3),
            $id,
        ]);
        applyProductCard($id, $repriceAll);
        if ($ingredientId !== null) {
            syncIngredientUnit($ingredientId);
        }
    });
    return getProduct($id);
}

// Applica la scheda dell'articolo ai suoi acquisti in cui lo scontrino non riporta né il peso
// né il formato: il prezzo al kg (cose pesate al banco) o il formato della confezione.
function applyProductCard(int $productId, bool $repriceAll = false): void
{
    $t = tables();
    $stmt = db()->prepare("SELECT package_size, package_unit, price_per_kg FROM {$t['products']} WHERE id = ?");
    $stmt->execute([$productId]);
    $product = $stmt->fetch();
    $perKg = $product ? nullableFloat($product['price_per_kg']) : null;
    $size = $product ? nullableFloat($product['package_size']) : null;
    applyWeightToItems('product_id = ?', [$productId], $perKg, $repriceAll);
    applyPackageToItems('product_id = ?', [$productId], $size, $size === null ? null : $product['package_unit']);
}

// Il prezzo al kg scritto sulla scheda dell'articolo serve per le cose pesate al banco quando
// lo scontrino riporta solo l'importo: il peso si ricava come importo / prezzo al kg.
// Vince solo un peso stampato: un formato letto sullo scontrino per una cosa pesata al banco
// è un errore di lettura, ma resta salvato e torna a valere se si toglie il prezzo al kg.
// Gli acquisti già calcolati tengono il prezzo al kg di allora, così lo storico resta vero,
// a meno di $repriceAll. Senza prezzo al kg, quelli che lo avevano preso da lì tornano senza peso.
function applyWeightToItems(string $where, array $params, ?float $perKg, bool $repriceAll = false): void
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT id, quantity, price_full, price_paid, weight_kg, weight_from_product, package_size, package_unit
         FROM {$t['receipt_items']} WHERE $where"
    );
    $stmt->execute($params);
    $update = db()->prepare(
        "UPDATE {$t['receipt_items']}
         SET weight_kg = ?, weight_from_product = ?, ref_amount = ?, ref_unit = ?, ref_price_full = ?, ref_price_paid = ?
         WHERE id = ?"
    );
    foreach ($stmt->fetchAll() as $item) {
        $derived = (bool) $item['weight_from_product'];
        $printed = !$derived && $item['weight_kg'] !== null;
        $full = (float) $item['price_full'];
        if ($printed || $full <= 0 || ($perKg === null && !$derived) || ($perKg !== null && $derived && !$repriceAll)) {
            continue;
        }
        if ($perKg === null) {
            // Di nuovo con il formato della riga, se c'è, altrimenti a pezzo.
            $ref = referencePrice([
                'weightKg' => null,
                'packageSize' => nullableFloat($item['package_size']),
                'packageUnit' => $item['package_unit'],
                'quantity' => (float) $item['quantity'],
                'priceFull' => $full,
                'pricePaid' => (float) $item['price_paid'],
            ]);
            $update->execute([null, 0, $ref['refAmount'], $ref['refUnit'], $ref['refPriceFull'], $ref['refPricePaid'], (int) $item['id']]);
            continue;
        }
        // Prezzi al kg dal valore della scheda, non dal peso arrotondato ai grammi.
        $paid = (float) $item['price_paid'];
        $update->execute([
            round($full / $perKg, 3), 1, round($full / $perKg, 4), 'kg',
            round($perKg, 4), $paid > 0 ? round($perKg * $paid / $full, 4) : null,
            (int) $item['id'],
        ]);
    }
}

function applyPackageToItems(string $where, array $params, ?float $size, ?string $unit): void
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT id, quantity, price_full, price_paid, package_size, package_estimated, package_from_product
         FROM {$t['receipt_items']} WHERE weight_kg IS NULL AND $where"
    );
    $stmt->execute($params);
    $update = db()->prepare(
        "UPDATE {$t['receipt_items']}
         SET package_size = ?, package_unit = ?, package_estimated = ?, package_from_product = ?,
             ref_amount = ?, ref_unit = ?, ref_price_full = ?, ref_price_paid = ?
         WHERE id = ?"
    );
    foreach ($stmt->fetchAll() as $item) {
        $printed = $item['package_size'] !== null && !$item['package_estimated'] && !$item['package_from_product'];
        if ($printed) {
            continue; // il formato stampato sullo scontrino vince sempre
        }
        if ($size === null && !$item['package_from_product']) {
            continue; // niente da applicare: resta com'è (a pezzo o con la stima dell'AI)
        }
        $line = [
            'weightKg' => null,
            'packageSize' => $size,
            'packageUnit' => $size === null ? null : $unit,
            'quantity' => (float) $item['quantity'],
            'priceFull' => (float) $item['price_full'],
            'pricePaid' => (float) $item['price_paid'],
        ];
        $ref = referencePrice($line);
        $update->execute([
            $line['packageSize'], $line['packageUnit'], 0, $size === null ? 0 : 1,
            $ref['refAmount'], $ref['refUnit'], $ref['refPriceFull'], $ref['refPricePaid'],
            (int) $item['id'],
        ]);
    }
}

// Se l'ingrediente non ha più nessun prezzo nella sua unità ma ne ha in un'altra
// (es. il riso era comprato "a pezzo" e ora ha il formato da 1 kg), passa a quella.
function syncIngredientUnit(int $ingredientId): void
{
    $t = tables();
    $stmt = db()->prepare("SELECT unit FROM {$t['ingredients']} WHERE id = ?");
    $stmt->execute([$ingredientId]);
    $unit = $stmt->fetchColumn();
    $units = array_unique(array_column(
        purchases('WHERE p.ingredient_id = ? AND ri.ref_price_full IS NOT NULL', [$ingredientId]),
        'ref_unit'
    ));
    if ($unit !== false && $units && !in_array($unit, $units, true)) {
        db()->prepare("UPDATE {$t['ingredients']} SET unit = ? WHERE id = ?")->execute([reset($units), $ingredientId]);
    }
}

// Riunisce due articoli che sono la stessa cosa: acquisti e descrizioni passano a $intoId.
function mergeProduct(int $id, array $input): array
{
    $t = tables();
    $intoId = idFromInput($input['into'] ?? null);
    if ($intoId === null || $intoId === $id) {
        throw new HttpError(400, "Scegli un altro articolo in cui unire questo");
    }
    $source = getProduct($id);
    $target = getProduct($intoId);
    transaction(function (PDO $pdo) use ($t, $id, $intoId, $source, $target) {
        $pdo->prepare("UPDATE {$t['receipt_items']} SET product_id = ? WHERE product_id = ?")->execute([$intoId, $id]);
        $pdo->prepare("UPDATE {$t['product_aliases']} SET product_id = ? WHERE product_id = ?")->execute([$intoId, $id]);
        // Ingrediente e formato (o prezzo al kg) dell'articolo eliminato servono se l'altro non li ha.
        if ($target['ingredientId'] === null && $source['ingredientId'] !== null) {
            $pdo->prepare("UPDATE {$t['products']} SET ingredient_id = ? WHERE id = ?")->execute([(int) $source['ingredientId'], $intoId]);
        }
        if ($target['packageSize'] === null && $target['pricePerKg'] === null) {
            $pdo->prepare("UPDATE {$t['products']} SET package_size = ?, package_unit = ?, price_per_kg = ? WHERE id = ?")
                ->execute([$source['packageSize'], $source['packageUnit'], $source['pricePerKg'], $intoId]);
        }
        $pdo->prepare("DELETE FROM {$t['products']} WHERE id = ?")->execute([$id]);
        applyProductCard($intoId);
    });
    return getProduct($intoId);
}

// Elimina un articolo: le righe degli scontrini restano, senza articolo (e senza il peso o
// il formato presi dalla sua scheda), e le descrizioni abbinate vengono dimenticate.
function deleteProduct(int $id): void
{
    $t = tables();
    transaction(function (PDO $pdo) use ($t, $id) {
        applyWeightToItems('product_id = ?', [$id], null);
        applyPackageToItems('product_id = ?', [$id], null, null);
        $stmt = $pdo->prepare("DELETE FROM {$t['products']} WHERE id = ?");
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) {
            throw new HttpError(404, 'Articolo non trovato');
        }
    });
}

// ---------------------------------------------------------------------------
// Scontrini
// ---------------------------------------------------------------------------

// Chiave delle descrizioni già abbinate: stesso negozio + stessa descrizione = stesso articolo.
function aliasHash(string $store, string $description): string
{
    return sha1(fold($store) . '|' . fold($description));
}

// Quantità in kg / l / pz e prezzo per quell'unità, pieno e pagato.
function referencePrice(array $line): array
{
    if ($line['weightKg'] !== null) {
        [$amount, $unit] = [$line['weightKg'], 'kg'];
    } elseif ($line['packageSize'] !== null) {
        [$unit, $factor] = AMOUNT_UNITS[$line['packageUnit']];
        $amount = $line['quantity'] * $line['packageSize'] * $factor;
    } else {
        [$amount, $unit] = [$line['quantity'], 'pz'];
    }
    $valid = $amount > 0 && $line['priceFull'] > 0;
    return [
        'refAmount' => round($amount, 4),
        'refUnit' => $unit,
        'refPriceFull' => $valid ? round($line['priceFull'] / $amount, 4) : null,
        'refPricePaid' => $valid && $line['pricePaid'] > 0 ? round($line['pricePaid'] / $amount, 4) : null,
    ];
}

// Una riga del JSON dell'AI, ripulita. null se manca la descrizione o qualunque prezzo.
function normalizeReceiptLine(array $row): ?array
{
    $name = cleanLine($row['nome'] ?? null, 120);
    $description = cleanLine($row['descrizione'] ?? null, 200);
    if ($description === '') {
        $description = $name;
    }
    if ($description === '') {
        return null;
    }

    $quantity = toNumber($row['quantita'] ?? null);
    $quantity = $quantity !== null && $quantity > 0 ? $quantity : 1.0;
    $weight = toNumber($row['peso_kg'] ?? null);
    $weight = $weight !== null && $weight > 0 ? $weight : null;
    $unitPrice = toNumber($row['prezzo_unitario'] ?? null);
    $perKg = toNumber($row['prezzo_al_kg'] ?? null);
    $discount = abs(toNumber($row['sconto'] ?? null) ?? 0.0);
    $paid = toNumber($row['prezzo_pagato'] ?? null);
    $full = toNumber($row['prezzo_pieno'] ?? null)
        ?? ($unitPrice !== null ? $unitPrice * $quantity : null)
        ?? ($weight !== null && $perKg !== null ? $weight * $perKg : null)
        ?? ($paid !== null ? $paid + $discount : null);
    if ($full === null) {
        return null;
    }
    $paid = $paid ?? $full - $discount;

    // Formato di una confezione; non ha senso per i prodotti pesati.
    $size = null;
    $sizeUnit = null;
    $estimated = false;
    $format = $row['formato'] ?? null;
    if ($weight === null && is_array($format)) {
        $value = toNumber($format['valore'] ?? null);
        $unit = is_string($format['unita'] ?? null) ? strtolower(trim($format['unita'])) : '';
        if ($value !== null && $value > 0 && isset(AMOUNT_UNITS[$unit])) {
            [$size, $sizeUnit, $estimated] = [$value, $unit, !empty($format['stimato'])];
        }
    }
    // Stampato il prezzo al kg ma non il peso: il peso si ricava dall'importo.
    $weightFromPerKg = $weight === null && $size === null && $perKg !== null && $perKg > 0 && $full > 0;
    if ($weightFromPerKg) {
        $weight = $full / $perKg;
    }

    $category = $row['categoria'] ?? null;
    $line = [
        'description' => $description,
        'name' => $name !== '' ? $name : $description,
        'brand' => cleanLine($row['marca'] ?? null, 60),
        'category' => in_array($category, PRODUCT_CATEGORIES, true) ? $category : 'altro',
        'quantity' => round($quantity, 3),
        'weightKg' => $weight === null ? null : round($weight, 3),
        'packageSize' => $size === null ? null : round($size, 3),
        'packageUnit' => $sizeUnit,
        'packageEstimated' => $estimated,
        'unitPrice' => $unitPrice === null ? null : round($unitPrice, 3),
        'printedPricePerKg' => $perKg === null ? null : round($perKg, 3),
        'priceFull' => round($full, 2),
        'discount' => round($discount, 2),
        'pricePaid' => round($paid, 2),
        'suggestedIngredient' => cleanLine($row['ingrediente'] ?? null, 80),
    ];
    if ($weightFromPerKg) {
        // Prezzi al kg da quello stampato, non dal peso arrotondato ai grammi.
        return $line + [
            'refAmount' => round($full / $perKg, 4),
            'refUnit' => 'kg',
            'refPriceFull' => round($perKg, 4),
            'refPricePaid' => $paid > 0 ? round($perKg * $paid / $full, 4) : null,
        ];
    }
    return $line + referencePrice($line);
}

// Il JSON restituito dall'AI (formato descritto in prompt-scontrino.txt), ripulito e controllato.
function normalizeReceipt(array $data): array
{
    $warnings = [];
    foreach (is_array($data['avvisi'] ?? null) ? $data['avvisi'] : [] as $warning) {
        $warning = cleanLine($warning, 300);
        if ($warning !== '') {
            $warnings[] = $warning;
        }
    }

    $date = is_string($data['data'] ?? null) ? trim($data['data']) : '';
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    $date = $parsed !== false && $parsed->format('Y-m-d') === $date ? $date : null;
    $time = is_string($data['ora'] ?? null) && preg_match('/^([01]?\d|2[0-3])[:.]([0-5]\d)/', trim($data['ora']), $m)
        ? sprintf('%02d:%02d', (int) $m[1], (int) $m[2])
        : null;

    $extraDiscount = 0.0;
    foreach (is_array($data['sconti_non_assegnati'] ?? null) ? $data['sconti_non_assegnati'] : [] as $item) {
        $extraDiscount += abs(toNumber(is_array($item) ? ($item['importo'] ?? null) : $item) ?? 0.0);
    }

    $lines = [];
    $rows = is_array($data['righe'] ?? null) ? array_values($data['righe']) : [];
    foreach ($rows as $index => $row) {
        $line = is_array($row) ? normalizeReceiptLine($row) : null;
        if ($line === null) {
            $warnings[] = 'Riga ' . ($index + 1) . ' ignorata: mancano descrizione o prezzo';
            continue;
        }
        $lines[] = ['index' => $index] + $line;
    }
    if (!$lines) {
        throw new HttpError(400, 'Nello scontrino non ci sono righe con prodotti e prezzi');
    }

    $total = toNumber($data['totale'] ?? null);
    $sum = round(array_sum(array_column($lines, 'pricePaid')) - $extraDiscount, 2);
    if ($total !== null && abs($sum - $total) > 0.01) {
        $warnings[] = 'La somma delle righe (' . euro($sum) . ') non corrisponde al totale (' . euro($total) . ')';
    }

    $store = cleanLine($data['negozio'] ?? null, 80);
    return [
        'store' => $store !== '' ? $store : 'Negozio sconosciuto',
        'address' => cleanLine($data['indirizzo'] ?? null, 200),
        'date' => $date,
        'time' => $time,
        'total' => $total === null ? null : round($total, 2),
        'extraDiscount' => round($extraDiscount, 2),
        'sum' => $sum,
        'warnings' => array_slice($warnings, 0, 30),
        'lines' => array_slice($lines, 0, 300),
    ];
}

// Per ogni riga cerca l'articolo già noto: stessa descrizione nello stesso negozio,
// poi stessa descrizione in un altro negozio, infine stesso nome proposto dall'AI.
function matchLines(string $store, array $lines): array
{
    $t = tables();
    $products = [];
    $byName = [];
    $sql = "SELECT p.id, p.name, i.name AS ingredient FROM {$t['products']} p LEFT JOIN {$t['ingredients']} i ON i.id = p.ingredient_id";
    foreach (db()->query($sql)->fetchAll() as $row) {
        $products[(int) $row['id']] = $row;
        $byName[fold($row['name'])] = (int) $row['id'];
    }
    $byHash = [];
    $byDescription = [];
    foreach (db()->query("SELECT product_id, description, alias_hash FROM {$t['product_aliases']}")->fetchAll() as $row) {
        $byHash[$row['alias_hash']] = (int) $row['product_id'];
        $byDescription[fold($row['description'])] ??= (int) $row['product_id'];
    }
    $ingredients = [];
    foreach (db()->query("SELECT name FROM {$t['ingredients']}")->fetchAll(PDO::FETCH_COLUMN) as $name) {
        $ingredients[fold($name)] = $name;
    }

    foreach ($lines as &$line) {
        $candidates = [
            'alias' => $byHash[aliasHash($store, $line['description'])] ?? null,
            'description' => $byDescription[fold($line['description'])] ?? null,
            'name' => $byName[fold($line['name'])] ?? null,
        ];
        $line['match'] = null;
        foreach ($candidates as $via => $id) {
            if ($id !== null) {
                $line['match'] = [
                    'productId' => (string) $id,
                    'product' => $products[$id]['name'],
                    'ingredient' => $products[$id]['ingredient'],
                    'via' => $via,
                ];
                break;
            }
        }
        // L'ingrediente proposto dall'AI, con il nome esatto se esiste già.
        $suggested = $line['suggestedIngredient'];
        $line['suggestedIngredient'] = $suggested === '' ? '' : ($ingredients[fold($suggested)] ?? $suggested);
    }
    unset($line);
    return $lines;
}

function findDuplicateReceipt(array $receipt): ?string
{
    if ($receipt['date'] === null) {
        return null;
    }
    $t = tables();
    $stmt = db()->prepare("SELECT id FROM {$t['receipts']} WHERE store = ? AND purchased_on = ? AND total <=> ? LIMIT 1");
    $stmt->execute([$receipt['store'], $receipt['date'], $receipt['total']]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (string) $id;
}

// Anteprima dell'importazione: righe ripulite, abbinamenti proposti, eventuale doppione.
function previewReceipt(array $input): array
{
    if (!is_array($input['receipt'] ?? null)) {
        throw new HttpError(400, 'Manca lo scontrino in formato JSON');
    }
    $receipt = normalizeReceipt($input['receipt']);
    $receipt['lines'] = matchLines($receipt['store'], $receipt['lines']);
    $receipt['duplicateOf'] = findDuplicateReceipt($receipt);
    return $receipt;
}

// Articolo scelto per una riga: quello esistente con questo nome, oppure uno nuovo.
// L'ingrediente indicato viene collegato all'articolo (vuoto = nessun ingrediente).
function resolveProduct(string $name, string $ingredientName, array $line): ?int
{
    $t = tables();
    $name = cleanLine($name, 120);
    if ($name === '') {
        return null;
    }
    $ingredientId = ingredientIdByName($ingredientName, $line['refUnit'] ?? 'kg');
    $stmt = db()->prepare("SELECT id FROM {$t['products']} WHERE name = ? LIMIT 1");
    $stmt->execute([$name]);
    $id = $stmt->fetchColumn();
    if ($id !== false) {
        db()->prepare("UPDATE {$t['products']} SET ingredient_id = ? WHERE id = ?")->execute([$ingredientId, $id]);
        return (int) $id;
    }
    $hasPackage = ($line['packageSize'] ?? null) !== null && empty($line['packageEstimated']);
    db()->prepare(
        "INSERT INTO {$t['products']} (name, brand, category, ingredient_id, package_size, package_unit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())"
    )->execute([
        $name,
        $line['brand'] ?? '',
        $line['category'] ?? 'altro',
        $ingredientId,
        $hasPackage ? $line['packageSize'] : null,
        $hasPackage ? $line['packageUnit'] : null,
    ]);
    return (int) db()->lastInsertId();
}

// Ricorda che questa descrizione, in questo negozio, è questo articolo (o lo dimentica).
function rememberAlias(string $store, string $description, ?int $productId): void
{
    $t = tables();
    $hash = aliasHash($store, $description);
    if ($productId === null) {
        db()->prepare("DELETE FROM {$t['product_aliases']} WHERE alias_hash = ?")->execute([$hash]);
        return;
    }
    db()->prepare(
        "INSERT INTO {$t['product_aliases']} (product_id, store, description, alias_hash) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE product_id = ?"
    )->execute([$productId, $store, $description, $hash, $productId]);
}

// Salva lo scontrino. $input: { receipt: JSON dell'AI (eventualmente corretto),
// choices: { indice riga: { product: nome articolo, ingredient: nome ingrediente } } }
function saveReceipt(array $input): array
{
    $t = tables();
    if (!is_array($input['receipt'] ?? null)) {
        throw new HttpError(400, 'Manca lo scontrino in formato JSON');
    }
    $source = $input['receipt'];
    $receipt = normalizeReceipt($source);
    if ($receipt['date'] === null) {
        throw new HttpError(400, 'Indica la data dello scontrino');
    }
    $choices = is_array($input['choices'] ?? null) ? $input['choices'] : [];

    $receiptId = 0;
    transaction(function (PDO $pdo) use ($t, $receipt, $source, $choices, &$receiptId) {
        $pdo->prepare(
            "INSERT INTO {$t['receipts']} (store, address, purchased_on, purchased_time, total, extra_discount, warnings, source_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())"
        )->execute([
            $receipt['store'],
            $receipt['address'],
            $receipt['date'],
            $receipt['time'],
            $receipt['total'],
            $receipt['extraDiscount'],
            json_encode($receipt['warnings'], JSON_UNESCAPED_UNICODE),
            json_encode($source, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        $receiptId = (int) $pdo->lastInsertId();

        $insert = $pdo->prepare(
            "INSERT INTO {$t['receipt_items']} (receipt_id, position, description, name, brand, category, product_id,
                quantity, weight_kg, package_size, package_unit, package_estimated, unit_price,
                price_full, discount, price_paid, ref_amount, ref_unit, ref_price_full, ref_price_paid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        $productIds = [];
        foreach ($receipt['lines'] as $position => $line) {
            $choice = $choices[$line['index']] ?? null;
            $productId = is_array($choice)
                ? resolveProduct(
                    is_string($choice['product'] ?? null) ? $choice['product'] : '',
                    is_string($choice['ingredient'] ?? null) ? $choice['ingredient'] : '',
                    $line
                )
                : null;
            $insert->execute([
                $receiptId, $position, $line['description'], $line['name'], $line['brand'], $line['category'], $productId,
                $line['quantity'], $line['weightKg'], $line['packageSize'], $line['packageUnit'], $line['packageEstimated'] ? 1 : 0,
                $line['unitPrice'], $line['priceFull'], $line['discount'], $line['pricePaid'],
                $line['refAmount'], $line['refUnit'], $line['refPriceFull'], $line['refPricePaid'],
            ]);
            if ($productId !== null) {
                rememberAlias($receipt['store'], $line['description'], $productId);
                $productIds[$productId] = true;
            }
        }
        refreshProducts(array_keys($productIds));
    });

    return ['id' => (string) $receiptId];
}

// Dopo aver collegato delle righe: scheda degli articoli sugli acquisti e unità degli ingredienti.
function refreshProducts(array $productIds): void
{
    $t = tables();
    $ingredient = db()->prepare("SELECT ingredient_id FROM {$t['products']} WHERE id = ?");
    foreach ($productIds as $productId) {
        applyProductCard((int) $productId);
        $ingredient->execute([(int) $productId]);
        $ingredientId = $ingredient->fetchColumn();
        if ($ingredientId !== false && $ingredientId !== null) {
            syncIngredientUnit((int) $ingredientId);
        }
    }
}

function listReceipts(): array
{
    $t = tables();
    $rows = db()->query(
        "SELECT r.id, r.store, r.purchased_on, r.purchased_time, r.total, r.extra_discount,
                (SELECT COUNT(*) FROM {$t['receipt_items']} ri WHERE ri.receipt_id = r.id) AS items,
                (SELECT COUNT(*) FROM {$t['receipt_items']} ri WHERE ri.receipt_id = r.id AND ri.product_id IS NULL) AS unlinked,
                (SELECT COALESCE(SUM(ri.price_paid), 0) FROM {$t['receipt_items']} ri WHERE ri.receipt_id = r.id) AS paid,
                (SELECT COALESCE(SUM(ri.discount), 0) FROM {$t['receipt_items']} ri WHERE ri.receipt_id = r.id) AS discounts
         FROM {$t['receipts']} r
         ORDER BY r.purchased_on DESC, r.purchased_time DESC, r.id DESC"
    )->fetchAll();
    return array_map(function (array $row) {
        return [
            'id' => (string) $row['id'],
            'store' => $row['store'],
            'date' => $row['purchased_on'],
            'time' => $row['purchased_time'] === null ? null : substr($row['purchased_time'], 0, 5),
            'total' => nullableFloat($row['total']),
            'extraDiscount' => (float) $row['extra_discount'],
            'items' => (int) $row['items'],
            'unlinked' => (int) $row['unlinked'],
            'paid' => (float) $row['paid'],
            'discounts' => (float) $row['discounts'],
        ];
    }, $rows);
}

function getReceipt(int $id): array
{
    $t = tables();
    $stmt = db()->prepare(
        "SELECT id, store, address, purchased_on, purchased_time, total, extra_discount, warnings
         FROM {$t['receipts']} WHERE id = ?"
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        throw new HttpError(404, 'Scontrino non trovato');
    }

    $stmt = db()->prepare(
        "SELECT ri.*, p.name AS product, i.name AS ingredient
         FROM {$t['receipt_items']} ri
         LEFT JOIN {$t['products']} p ON p.id = ri.product_id
         LEFT JOIN {$t['ingredients']} i ON i.id = p.ingredient_id
         WHERE ri.receipt_id = ?
         ORDER BY ri.position"
    );
    $stmt->execute([$id]);
    $lines = array_map(function (array $item) {
        return [
            'id' => (string) $item['id'],
            'description' => $item['description'],
            'name' => $item['name'],
            'brand' => $item['brand'],
            'category' => $item['category'],
            'quantity' => (float) $item['quantity'],
            'weightKg' => nullableFloat($item['weight_kg']),
            'weightFromProduct' => (bool) $item['weight_from_product'],
            'packageSize' => nullableFloat($item['package_size']),
            'packageUnit' => $item['package_unit'],
            'packageEstimated' => (bool) $item['package_estimated'],
            'packageFromProduct' => (bool) $item['package_from_product'],
            'unitPrice' => nullableFloat($item['unit_price']),
            'priceFull' => (float) $item['price_full'],
            'discount' => (float) $item['discount'],
            'pricePaid' => (float) $item['price_paid'],
            'refUnit' => $item['ref_unit'],
            'refPriceFull' => nullableFloat($item['ref_price_full']),
            'refPricePaid' => nullableFloat($item['ref_price_paid']),
            'productId' => $item['product_id'] === null ? null : (string) $item['product_id'],
            'product' => $item['product'],
            'ingredient' => $item['ingredient'],
        ];
    }, $stmt->fetchAll());

    $warnings = json_decode((string) $row['warnings'], true);
    return [
        'id' => (string) $row['id'],
        'store' => $row['store'],
        'address' => $row['address'],
        'date' => $row['purchased_on'],
        'time' => $row['purchased_time'] === null ? null : substr($row['purchased_time'], 0, 5),
        'total' => nullableFloat($row['total']),
        'extraDiscount' => (float) $row['extra_discount'],
        'warnings' => is_array($warnings) ? $warnings : [],
        'lines' => $lines,
    ];
}

// Cambia gli abbinamenti di alcune righe: { lines: [ { id, product, ingredient } ] }.
function relinkReceipt(int $id, array $input): array
{
    $t = tables();
    $receipt = getReceipt($id);
    $items = [];
    foreach ($receipt['lines'] as $line) {
        $items[$line['id']] = $line;
    }
    $choices = is_array($input['lines'] ?? null) ? $input['lines'] : [];

    transaction(function (PDO $pdo) use ($t, $receipt, $items, $choices) {
        $productIds = [];
        $update = $pdo->prepare("UPDATE {$t['receipt_items']} SET product_id = ? WHERE id = ?");
        foreach ($choices as $choice) {
            $item = is_array($choice) ? ($items[(string) ($choice['id'] ?? '')] ?? null) : null;
            if ($item === null) {
                continue;
            }
            $productId = resolveProduct(
                is_string($choice['product'] ?? null) ? $choice['product'] : '',
                is_string($choice['ingredient'] ?? null) ? $choice['ingredient'] : '',
                $item
            );
            $update->execute([$productId, (int) $item['id']]);
            rememberAlias($receipt['store'], $item['description'], $productId);
            if ($item['productId'] !== ($productId === null ? null : (string) $productId)) {
                // Cambia articolo: perde il peso o il formato presi dalla scheda di quello vecchio.
                applyWeightToItems('id = ?', [(int) $item['id']], null);
                applyPackageToItems('id = ?', [(int) $item['id']], null, null);
            }
            if ($productId !== null) {
                $productIds[$productId] = true;
            }
        }
        refreshProducts(array_keys($productIds));
    });

    return getReceipt($id);
}

// Elimina lo scontrino e le sue righe; gli abbinamenti imparati restano.
function deleteReceipt(int $id): void
{
    $t = tables();
    $stmt = db()->prepare("DELETE FROM {$t['receipts']} WHERE id = ?");
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Scontrino non trovato');
    }
}
