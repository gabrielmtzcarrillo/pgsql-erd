import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEfCore, parseJsonModel } from '../src/renderer/lib/efimport.js';
import { modelFromSpecs } from '../src/renderer/lib/spreadsheet.js';

const CS = `
#nullable enable
namespace Shop;
public abstract class Entity { public int Id { get; set; } public DateTime CreatedAt { get; set; } }
[Table("customers", Schema = "shop")]
public class Customer : Entity {
  [Required, MaxLength(100)] public string Name { get; set; } = "";
  public string? Email { get; set; }
  public ICollection<Order> Orders { get; set; } = new List<Order>();
}
public class Order {
  public int OrderId { get; set; }
  public int CustomerId { get; set; }
  public Customer Customer { get; set; } = null!;
  public decimal Total { get; set; }
  public ICollection<Tag> Tags { get; set; }
}
public class Tag { public Guid Id { get; set; } public string Label { get; set; } public ICollection<Order> Orders { get; set; } }
public class ShopContext : DbContext {
  public DbSet<Customer> Customers { get; set; }
  public DbSet<Order> Orders { get; set; }
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.Entity<Order>(e => {
      e.HasKey(x => x.OrderId);
      e.Property(x => x.Total).HasPrecision(18, 2).HasDefaultValue(0m);
    });
    modelBuilder.Entity<Customer>().HasIndex(c => c.Email).IsUnique();
  }
}`;

const byName = (specs, name) => specs.find((s) => s.name === name);
const col = (spec, name) => spec.columns.find((c) => c.name === name);

test('reads entities, annotations, fluent API and conventions from C#', () => {
  const specs = parseEfCore(CS);
  assert.deepEqual(specs.map((s) => s.name).sort(), ['customers', 'orders', 'orders_tags', 'tag']);
  const customers = byName(specs, 'customers');
  assert.equal(customers.schema, 'shop');
  assert.equal(col(customers, 'id').type, 'serial');
  assert.ok(col(customers, 'id').pk);
  assert.ok(col(customers, 'created_at'), 'inherited from the base class');
  assert.deepEqual([col(customers, 'name').type, col(customers, 'name').length, col(customers, 'name').notNull], ['character varying', 100, true]);
  assert.equal(col(customers, 'email').notNull, false);
  assert.ok(col(customers, 'email').unique);
  const orders = byName(specs, 'orders');
  assert.ok(col(orders, 'order_id').pk);
  assert.deepEqual([col(orders, 'total').type, col(orders, 'total').length, col(orders, 'total').precision, col(orders, 'total').default], ['numeric', 18, 2, '0']);
  assert.deepEqual(col(orders, 'customer_id').ref, { schema: 'shop', table: 'customers', column: 'id' });
});

test('many-to-many collections get a join table with a composite key', () => {
  const join = byName(parseEfCore(CS), 'orders_tags');
  assert.deepEqual(join.columns.map((c) => [c.name, c.pk]), [['orders_order_id', true], ['tags_id', true]]);
  assert.equal(join.columns[1].ref.table, 'tag');
});

test('specs turn into a diagram model with links', () => {
  const { model, external } = modelFromSpecs(parseEfCore(CS));
  assert.equal(model.tables.length, 4);
  assert.equal(model.links.length, 3);
  assert.equal(external.length, 0);
});

test('reads IEntityTypeConfiguration and one-to-many fluent relationships', () => {
  const specs = parseEfCore(`
    public class Author { public int Id {get;set;} public List<Book> Books {get;set;} }
    public class Book { public int Id {get;set;} public int WrittenBy {get;set;} public string Title {get;set;} }
    public class BookConfig : IEntityTypeConfiguration<Book> {
      public void Configure(EntityTypeBuilder<Book> builder) {
        builder.ToTable("books", "lib");
        builder.Property(b => b.Title).HasColumnName("TITLE").HasMaxLength(50).IsRequired();
        builder.HasOne<Author>().WithMany(a => a.Books).HasForeignKey(b => b.WrittenBy);
      }
    }
    public class Ctx : DbContext { public DbSet<Author> Authors {get;set;} public DbSet<Book> Books {get;set;} }`);
  const books = byName(specs, 'books');
  assert.equal(books.schema, 'lib');
  assert.deepEqual([col(books, 'TITLE').type, col(books, 'TITLE').length], ['character varying', 50]);
  assert.deepEqual(col(books, 'written_by').ref, { schema: 'public', table: 'authors', column: 'id' });
});

test('a missing foreign key property becomes a shadow column', () => {
  const specs = parseEfCore(`
    public class Blog { public int Id {get;set;} }
    public class Post { public int Id {get;set;} public Blog Blog {get;set;} }`);
  assert.equal(col(byName(specs, 'post'), 'blog_id').ref.table, 'blog');
});

test('reads a JSON description', () => {
  const specs = parseJsonModel(JSON.stringify({
    schema: 'app',
    tables: [
      { name: 'Person', columns: [{ name: 'Id', type: 'serial', pk: true }, { name: 'Name', type: 'varchar(40)', nullable: false }] },
      { name: 'Pet', columns: [{ name: 'Id', type: 'int', pk: true }, { name: 'OwnerId', type: 'int', references: 'person.id' }] },
    ],
  }));
  assert.equal(specs[0].schema, 'app');
  assert.deepEqual([col(specs[0], 'name').type, col(specs[0], 'name').length, col(specs[0], 'name').notNull], ['character varying', 40, true]);
  assert.deepEqual(col(specs[1], 'owner_id').ref, { schema: null, table: 'person', column: 'id' });
  assert.equal(modelFromSpecs(specs).model.links.length, 1);
  assert.throws(() => parseJsonModel('{"x":1}'), /tables/);
});
