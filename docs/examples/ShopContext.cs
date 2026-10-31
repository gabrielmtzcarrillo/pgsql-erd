#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Shop;

public abstract class Entity
{
    public DateTime CreatedAt { get; set; }
}

[Table("customer", Schema = "shop")]
public class Customer : Entity
{
    public long Id { get; set; }

    [Required, MaxLength(255)]
    public string Email { get; set; } = "";

    public string? FullName { get; set; }

    public ICollection<Order> Orders { get; set; } = new List<Order>();
}

public class Product
{
    public int Id { get; set; }

    [MaxLength(32)]
    public string Sku { get; set; } = "";

    public string Name { get; set; } = "";
    public decimal Price { get; set; }
    public ICollection<Tag> Tags { get; set; } = new List<Tag>();
}

public class Tag
{
    public int Id { get; set; }
    public string Label { get; set; } = "";
    public ICollection<Product> Products { get; set; } = new List<Product>();
}

public class Order
{
    public long Id { get; set; }
    public long CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;

    [MaxLength(20)]
    public string Status { get; set; } = "new";

    public DateTimeOffset PlacedAt { get; set; }
    public List<OrderItem> Items { get; set; } = new();
}

public class OrderItem
{
    public long OrderId { get; set; }
    public Order Order { get; set; } = null!;
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    public int Quantity { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderItem> OrderItems => Set<OrderItem>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("shop");

        modelBuilder.Entity<Customer>().HasIndex(c => c.Email).IsUnique();

        modelBuilder.Entity<Product>(e =>
        {
            e.Property(p => p.Price).HasPrecision(10, 2);
            e.HasIndex(p => p.Sku).IsUnique();
        });

        modelBuilder.Entity<OrderItem>(e =>
        {
            e.HasKey(i => new { i.OrderId, i.ProductId });
            e.Property(i => i.Quantity).HasDefaultValue(1);
        });
    }
}
