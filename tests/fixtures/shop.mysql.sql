-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)
--
-- Host: localhost    Database: shop
-- ------------------------------------------------------
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

--
-- Table structure for table `category`
--

DROP TABLE IF EXISTS `category`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `category` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(60) NOT NULL,
  `parent_id` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_category_name` (`name`),
  KEY `fk_category_parent` (`parent_id`),
  CONSTRAINT `fk_category_parent` FOREIGN KEY (`parent_id`) REFERENCES `category` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Product groups';
/*!40101 SET character_set_client = @saved_cs_client */;

LOCK TABLES `category` WRITE;
/*!40000 ALTER TABLE `category` DISABLE KEYS */;
INSERT INTO `category` VALUES (1,'Books',NULL),(2,'Comics',1),(3,'Tools; hardware',NULL);
/*!40000 ALTER TABLE `category` ENABLE KEYS */;
UNLOCK TABLES;

DROP TABLE IF EXISTS `CustomerAccount`;
CREATE TABLE `CustomerAccount` (
  `Id` bigint NOT NULL AUTO_INCREMENT,
  `FullName` varchar(100) NOT NULL DEFAULT '',
  `IsActive` tinyint(1) NOT NULL DEFAULT '1',
  `Status` enum('new','vip','it''s') NOT NULL DEFAULT 'new' COMMENT 'Lifecycle state',
  `Balance` decimal(12,2) unsigned NOT NULL DEFAULT '0.00',
  `CreatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `SeenAt` timestamp NULL DEFAULT NULL,
  `Birthday` date DEFAULT NULL,
  `Flags` bit(1) NOT NULL DEFAULT b'0',
  `Avatar` blob,
  `Prefs` json DEFAULT NULL,
  `Code` char(8) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `Upper` varchar(100) GENERATED ALWAYS AS (upper(`FullName`)) VIRTUAL,
  PRIMARY KEY (`Id`),
  UNIQUE KEY `uq_code` (`Code`),
  UNIQUE KEY `uq_name_prefix` (`FullName`(20)),
  KEY `ix_created` (`CreatedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `CustomerAccount` WRITE;
INSERT INTO `CustomerAccount` VALUES (1,'O\'Brien \"Pat\"',1,'vip',10.50,'2026-01-02 03:04:05.678','2026-01-02 03:04:05','1990-05-06',_binary '\0',_binary 'PNG\0\n',x'7B7D','ABC12345','O\'BRIEN \"PAT\"'),(2,'Zoë – 名前',0,'it\'s',0.00,'2026-02-03 00:00:00.000',NULL,'0000-00-00',0x01,NULL,'{\"theme\": \"dark\"}',NULL,'ZOË – 名前');
UNLOCK TABLES;

DROP TABLE IF EXISTS `order_line`;
CREATE TABLE `order_line` (
  `customer_id` bigint NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `category_id` int unsigned NOT NULL,
  `qty` mediumint NOT NULL DEFAULT '1',
  `price` double DEFAULT NULL,
  `year` year DEFAULT NULL,
  PRIMARY KEY (`customer_id`,`line_no`),
  CONSTRAINT `fk_line_customer` FOREIGN KEY (`customer_id`) REFERENCES `CustomerAccount` (`Id`) ON DELETE CASCADE,
  CONSTRAINT `fk_line_category` FOREIGN KEY (`category_id`) REFERENCES `category` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `order_line` (`customer_id`, `line_no`, `category_id`, `qty`, `price`, `year`) VALUES (1,1,2,3,9.99,2026),(1,2,3,-1,1e3,NULL),(2,1,1,1,NULL,1999);

DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER `trg` BEFORE INSERT ON `order_line` FOR EACH ROW BEGIN
  SET NEW.qty = GREATEST(NEW.qty, 1);
END */;;
DELIMITER ;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
-- Dump completed on 2026-11-17 10:00:00
